import path from 'node:path'

import { DELEVERAGER_ROLE_KEY } from '@panoptic-eng/sdk/zodiac'
import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem'
import { encodeFunctionData, zeroAddress } from 'viem'

import {
  assertSafeCanReceiveErc1155,
  readSafeFallbackHandler,
} from '../../src/safe/erc1155Receiver'
import { assertBotIsNotSafeOwner, readSafeOwners } from '../../src/security/safeOwnerInvariant'
import {
  formatAuthorizationManifestDiff,
  inspectExactAuthorizationManifest,
  verifySfpmSwapAuthorization,
} from './authorizationManifest'
import {
  type ConfigureCall,
  type ExtraRoleSpec,
  type SafeTokenApproval,
  type SfpmSwapConfigureInput,
  buildConfigureCalls,
  deployRolesModifier,
} from './deployCore'
import type { Prompter } from './prompts'
import { writeSafeTransactionBuilderBatch } from './safeProposal'
import { type SafeZodiacAddresses, findContractDeploymentBlock } from './safeZodiacRegistry'
import { verifyDeleveragerScope, verifyLoanOnlyScope } from './verifyScope'

/**
 * Existing-Safe onboarding: wire a Roles v2 modifier + loan-only scope onto a
 * Safe the user ALREADY controls (owner = their hardware wallet / multisig), for
 * either (a) adding a new PanopticPool to an existing hedger setup or (b) a clean
 * Safe they generated themselves.
 *
 * The bot can deploy the Roles modifier itself (permissionless), but the
 * owner-gated calls (enableModule + assign/scope) can only be authorized by the
 * Safe owner. Since that owner is typically a hardware wallet with no pasteable
 * key, we export the exact transactions as a Safe Transaction Builder batch,
 * then poll on-chain until the loan-only boundary is live.
 */

const safeReadAbi = [
  {
    type: 'function',
    name: 'isModuleEnabled',
    stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getModulesPaginated',
    stateMutability: 'view',
    inputs: [
      { name: 'start', type: 'address' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      { name: 'array', type: 'address[]' },
      { name: 'next', type: 'address' },
    ],
  },
] as const

const safeAdminAbi = [
  {
    type: 'function',
    name: 'disableModule',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'prevModule', type: 'address' },
      { name: 'module', type: 'address' },
    ],
    outputs: [],
  },
] as const
const MODULE_SENTINEL = '0x0000000000000000000000000000000000000001'

const erc20AllowanceAbi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const
/**
 * Approvals are granted at maxUint256, but tokens without an infinite-allowance
 * special case (e.g. USDC's FiatToken) decrement it on every transferFrom. A
 * strict equality check would report a healthy, already-swapping Safe as
 * missing approvals, so treat anything at or above 2^255 as "effectively max".
 */
const MIN_EFFECTIVE_MAX_ALLOWANCE = 1n << 255n

async function approvalsReady(
  publicClient: PublicClient,
  safeAddress: `0x${string}`,
  approvals: readonly SafeTokenApproval[],
): Promise<boolean> {
  const allowances = await Promise.all(
    approvals.map(({ token, spender }) =>
      publicClient.readContract({
        address: token,
        abi: erc20AllowanceAbi,
        functionName: 'allowance',
        args: [safeAddress, spender],
      }),
    ),
  )
  return allowances.every((allowance) => allowance >= MIN_EFFECTIVE_MAX_ALLOWANCE)
}

export { readSafeOwners }

export async function isModuleEnabled(
  publicClient: PublicClient,
  safe: `0x${string}`,
  module: `0x${string}`,
): Promise<boolean> {
  return (await publicClient.readContract({
    address: safe,
    abi: safeReadAbi,
    functionName: 'isModuleEnabled',
    args: [module],
  })) as boolean
}

export function modulePredecessor(
  modules: readonly `0x${string}`[],
  next: `0x${string}`,
  module: `0x${string}`,
): `0x${string}` {
  const index = modules.findIndex((candidate) => candidate.toLowerCase() === module.toLowerCase())
  if (index < 0) throw new Error(`enabled module ${module} was not found in the Safe module list`)
  if (next.toLowerCase() !== MODULE_SENTINEL) {
    throw new Error('Safe has more than 256 modules; refusing automatic module replacement')
  }
  return index === 0 ? MODULE_SENTINEL : modules[index - 1]
}

async function findModulePredecessor(
  publicClient: PublicClient,
  safe: `0x${string}`,
  module: `0x${string}`,
): Promise<`0x${string}`> {
  const [modules, next] = (await publicClient.readContract({
    address: safe,
    abi: safeReadAbi,
    functionName: 'getModulesPaginated',
    args: [MODULE_SENTINEL, 256n],
  })) as readonly [`0x${string}`[], `0x${string}`]
  return modulePredecessor(modules, next, module)
}

/**
 * True once the bot can hedge this pool: the module is enabled on the Safe AND
 * the loan-only scope is live (loan dispatch allowed, option dispatch blocked).
 * The explicit module-enabled check guards a false positive where the scope
 * exists but the module is not yet enabled.
 */
async function scopeReady(
  publicClient: PublicClient,
  args: {
    safeAddress: `0x${string}`
    rolesModifierAddress: `0x${string}`
    botAddress: `0x${string}`
    roleKey: `0x${string}`
    poolAddress: `0x${string}`
    poolId: bigint
    extraRoles: ExtraRoleSpec[]
  },
): Promise<boolean> {
  if (!(await isModuleEnabled(publicClient, args.safeAddress, args.rolesModifierAddress))) {
    return false
  }
  try {
    await verifyLoanOnlyScope({
      publicClient,
      rolesModifierAddress: args.rolesModifierAddress,
      botAddress: args.botAddress,
      roleKey: args.roleKey,
      poolAddress: args.poolAddress,
      poolId: args.poolId,
      log: () => {},
    })
    // A requested deleverager role must also be live before setup can finish —
    // otherwise an add-role re-run would report "already scoped" and skip it.
    for (const spec of args.extraRoles) {
      if (spec.kind !== 'deleverager') continue
      await verifyDeleveragerScope({
        publicClient,
        rolesModifierAddress: args.rolesModifierAddress,
        botAddress: spec.member,
        roleKey: DELEVERAGER_ROLE_KEY,
        poolAddress: args.poolAddress,
        poolId: args.poolId,
        log: () => {},
      })
    }
    return true
  } catch {
    return false
  }
}

export async function verifySfpmSwapReady(
  publicClient: PublicClient,
  args: {
    safeAddress: `0x${string}`
    rolesModifierAddress: `0x${string}`
    roleKey: `0x${string}`
    deploymentBlock: bigint
    sfpmSwap: SfpmSwapConfigureInput
  },
): Promise<void> {
  await assertSafeCanReceiveErc1155({
    publicClient,
    safeAddress: args.safeAddress,
    tokenAddress: args.sfpmSwap.sfpm,
  })
  await verifySfpmSwapAuthorization({
    publicClient,
    rolesModifierAddress: args.rolesModifierAddress,
    deploymentBlock: args.deploymentBlock,
    roleKey: args.roleKey,
    safe: args.safeAddress,
    sfpm: args.sfpmSwap.sfpm,
    collateralTracker0: args.sfpmSwap.collateralTracker0,
    collateralTracker1: args.sfpmSwap.collateralTracker1,
    adapter: args.sfpmSwap.adapter,
    poolIdPin: args.sfpmSwap.poolIdPin,
    multiSendCallOnly: args.sfpmSwap.multiSendCallOnly,
    multiSendUnwrapper: args.sfpmSwap.multiSendUnwrapper,
    nativeCollateral: args.sfpmSwap.nativeCollateral,
    weth9: args.sfpmSwap.weth9,
  })
  const allowances = await Promise.all(
    args.sfpmSwap.approvals.map(({ token, spender }) =>
      publicClient.readContract({
        address: token,
        abi: erc20AllowanceAbi,
        functionName: 'allowance',
        args: [args.safeAddress, spender],
      }),
    ),
  )
  const missing = args.sfpmSwap.approvals.filter(
    (_, index) => allowances[index] < MIN_EFFECTIVE_MAX_ALLOWANCE,
  )
  if (missing.length > 0) {
    throw new Error(
      `SFPM venue approval missing for: ${missing
        .map(({ token, spender }) => `${token} → ${spender}`)
        .join(', ')}`,
    )
  }
}

async function sfpmSwapReady(
  publicClient: PublicClient,
  args: Parameters<typeof verifySfpmSwapReady>[1],
): Promise<boolean> {
  try {
    await verifySfpmSwapReady(publicClient, args)
    return true
  } catch {
    return false
  }
}

function exportOwnerCalls(
  chainId: number,
  safe: `0x${string}`,
  rolesModifier: `0x${string}`,
  calls: ConfigureCall[],
  log: (line: string) => void,
): void {
  const proposalPath = path.resolve(
    process.cwd(),
    `safe-onboarding-${rolesModifier.toLowerCase()}.json`,
  )
  writeSafeTransactionBuilderBatch(proposalPath, {
    chainId,
    safeAddress: safe,
    name: 'Configure Panoptic hedger bot',
    description:
      'Enables and configures the reviewed Zodiac Roles permission graph for Panoptic hedging.',
    calls,
  })
  log('\n──────── Execute these from your Safe owner (app.safe.global) ────────')
  log(`Safe: ${safe}`)
  log(`Proposal: ${proposalPath}`)
  log(`Calls: ${calls.length}`)
  log('Open your Safe → New transaction → Transaction Builder → upload the JSON file.')
  log('Review and simulate every call, collect the normal Safe approvals, then execute.')
  log('──────────────────────────────────────────────────────────────────────\n')
}

export interface ConfigureExistingSafeParams {
  publicClient: PublicClient
  chainId: number
  /** Bot wallet — deploys the modifier if needed (permissionless); never an owner. */
  walletClient: WalletClient<Transport, Chain, Account>
  prompter: Prompter
  addresses: SafeZodiacAddresses
  safeAddress: `0x${string}`
  /** Existing Panoptic Roles v2 modifier on this Safe, or undefined to deploy one. */
  rolesModifierAddress?: `0x${string}`
  botAddress: `0x${string}`
  roleKey: `0x${string}`
  poolAddress: `0x${string}`
  poolId: bigint
  /** Additional à-la-carte roles to scope (owner executes; verified in the poll). */
  extraRoles?: ExtraRoleSpec[]
  /** Core asset -> CollateralTracker approvals for Safe-owned deposits. */
  collateralApprovals?: SafeTokenApproval[]
  /** Optional off-venue SFPM swap scoping + approvals for the owner to execute. */
  sfpmSwap?: SfpmSwapConfigureInput
  /** Salt for the modifier proxy deploy (only used when deploying a new one). */
  saltNonce: bigint
  /** Persist the modifier address as soon as it lands, for a clean resume. */
  onModifierDeployed?: (address: `0x${string}`) => void | Promise<void>
  log?: (line: string) => void
}

/**
 * Deploy the Roles modifier if absent, then guide the Safe owner through the
 * owner-authorized enable/scope calls (unless already configured for this pool)
 * and poll until the loan-only boundary is live. Returns the wired addresses.
 */
export async function configureExistingSafe(
  params: ConfigureExistingSafeParams,
): Promise<{ safeAddress: `0x${string}`; rolesModifierAddress: `0x${string}` }> {
  const { publicClient, walletClient, prompter, addresses, safeAddress } = params
  const log = params.log ?? console.log

  await assertBotIsNotSafeOwner(publicClient, safeAddress, params.botAddress)

  // 1. Ensure a Roles modifier exists (bot deploys it; owner/avatar/target = Safe).
  let rolesModifierAddress = params.rolesModifierAddress
  let modifierToDisable: `0x${string}` | undefined
  let modifierPredecessor: `0x${string}` | undefined
  let rolesDeploymentBlock: bigint | undefined
  if (rolesModifierAddress) {
    const deploymentBlock = await findContractDeploymentBlock(publicClient, rolesModifierAddress)
    const deleverager = params.extraRoles?.find(({ kind }) => kind === 'deleverager')
    const diff = await inspectExactAuthorizationManifest({
      publicClient,
      rolesModifierAddress,
      botAddress: params.botAddress,
      roleKey: params.roleKey,
      poolAddress: params.poolAddress,
      deploymentBlock,
      deleverager: deleverager
        ? { member: deleverager.member, roleKey: DELEVERAGER_ROLE_KEY }
        : undefined,
      sfpmSwap: params.sfpmSwap
        ? {
            roleKey: params.roleKey,
            safe: safeAddress,
            ...params.sfpmSwap,
          }
        : undefined,
    })
    if (diff.unexpected.length > 0 || diff.changed.length > 0) {
      log('\n  ⚠️  The supplied Roles modifier contains permissions outside this bot profile:')
      log(`     ${formatAuthorizationManifestDiff({ ...diff, missing: [] })}`)
      const replace = await prompter.confirm(
        '  Create a fresh dedicated modifier for this Safe? (recommended)',
        true,
      )
      if (!replace) {
        throw new Error(
          'existing modifier was left unchanged; run `pnpm onboard` and accept the dedicated modifier',
        )
      }
      if (await isModuleEnabled(publicClient, safeAddress, rolesModifierAddress)) {
        modifierToDisable = rolesModifierAddress
        modifierPredecessor = await findModulePredecessor(
          publicClient,
          safeAddress,
          rolesModifierAddress,
        )
      }
      rolesModifierAddress = undefined
      log(
        '  → keeping your Safe; the approval batch will enable the new modifier and disable the old one.',
      )
    }
  }
  if (!rolesModifierAddress) {
    log('→ deploying a Roles v2 modifier for your Safe (bot pays gas)…')
    ;({ rolesModifierAddress, deploymentBlock: rolesDeploymentBlock } = await deployRolesModifier({
      publicClient,
      walletClient,
      addresses,
      safeAddress,
      saltNonce: params.saltNonce,
      log,
    }))
    log(`  Roles modifier: ${rolesModifierAddress}`)
    await params.onModifierDeployed?.(rolesModifierAddress)
  }

  const currentFallbackHandler = params.sfpmSwap
    ? await readSafeFallbackHandler(publicClient, safeAddress)
    : undefined
  if (params.sfpmSwap && currentFallbackHandler && currentFallbackHandler !== zeroAddress) {
    await assertSafeCanReceiveErc1155({
      publicClient,
      safeAddress,
      tokenAddress: params.sfpmSwap.sfpm,
    })
  }
  const fallbackHandler =
    currentFallbackHandler === zeroAddress ? addresses.compatibilityFallbackHandler : undefined
  const sfpmDeploymentBlock = params.sfpmSwap
    ? (rolesDeploymentBlock ??
      (await findContractDeploymentBlock(publicClient, rolesModifierAddress)))
    : undefined

  const readyArgs = {
    safeAddress,
    rolesModifierAddress,
    botAddress: params.botAddress,
    roleKey: params.roleKey,
    poolAddress: params.poolAddress,
    poolId: params.poolId,
    extraRoles: params.extraRoles ?? [],
  }

  const ready = async (): Promise<boolean> => {
    if (!(await scopeReady(publicClient, readyArgs))) return false
    if (!(await approvalsReady(publicClient, safeAddress, params.collateralApprovals ?? []))) {
      return false
    }
    if (
      modifierToDisable &&
      (await isModuleEnabled(publicClient, safeAddress, modifierToDisable))
    ) {
      return false
    }
    if (!params.sfpmSwap || sfpmDeploymentBlock === undefined) return true
    return sfpmSwapReady(publicClient, {
      safeAddress,
      rolesModifierAddress,
      roleKey: params.roleKey,
      deploymentBlock: sfpmDeploymentBlock,
      sfpmSwap: params.sfpmSwap,
    })
  }

  // 2. Idempotent: return only when every requested surface is live. In
  //    particular, an older loan-only setup must not skip newer SFPM scopes,
  //    approvals, or the Safe ERC-1155 fallback handler.
  if (await ready()) {
    log('  ✓ Safe already enabled + all requested scopes/approvals are live.')
    return { safeAddress, rolesModifierAddress }
  }

  // 3. Build only the owner-authorized calls that are still missing.
  const includeEnableModule = !(await isModuleEnabled(
    publicClient,
    safeAddress,
    rolesModifierAddress,
  ))
  const calls = buildConfigureCalls({
    safeAddress,
    rolesModifierAddress,
    botAddress: params.botAddress,
    roleKey: params.roleKey,
    poolAddress: params.poolAddress,
    extraRoles: params.extraRoles,
    collateralApprovals: params.collateralApprovals,
    sfpmSwap: params.sfpmSwap,
    fallbackHandler,
    includeEnableModule,
  })
  if (modifierToDisable && modifierPredecessor) {
    // Must run BEFORE enableModule: the predecessor was read from the current
    // module list, and Safe's enableModule prepends at the sentinel. If the old
    // modifier is the list head, enabling first would make SENTINEL point at the
    // new modifier and disableModule(SENTINEL, old) would revert the whole batch.
    calls.unshift({
      description: `disable stale Roles modifier ${modifierToDisable}`,
      to: safeAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: safeAdminAbi,
        functionName: 'disableModule',
        args: [modifierPredecessor, modifierToDisable],
      }),
    })
  }
  exportOwnerCalls(params.chainId, safeAddress, rolesModifierAddress, calls, log)

  // 4. Poll until the owner has executed them (Roles scoping is additive, so an
  //    existing pool on this modifier/role stays scoped).
  for (;;) {
    await prompter.text(
      '  Press Enter once you have executed the transaction(s) in the Safe (I will re-check)',
    )
    if (await ready()) {
      await assertBotIsNotSafeOwner(publicClient, safeAddress, params.botAddress)
      log('  ✓ detected on-chain: module, requested scopes, approvals, and Safe handler are live.')
      return { safeAddress, rolesModifierAddress }
    }
    log('  … not detected yet (txs may still be pending, or not all executed). Re-checking…')
  }
}
