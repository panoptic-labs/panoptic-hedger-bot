import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem'

import { assertBotIsNotSafeOwner, readSafeOwners } from '../../src/security/safeOwnerInvariant'
import { type ConfigureCall, buildConfigureCalls, deployRolesModifier } from './deployCore'
import type { Prompter } from './prompts'
import type { SafeZodiacAddresses } from './safeZodiacRegistry'
import { verifyLoanOnlyScope } from './verifyScope'

/**
 * Existing-Safe onboarding: wire a Roles v2 modifier + loan-only scope onto a
 * Safe the user ALREADY controls (owner = their hardware wallet / multisig), for
 * either (a) adding a new PanopticPool to an existing hedger setup or (b) a clean
 * Safe they generated themselves.
 *
 * The bot can deploy the Roles modifier itself (permissionless), but the
 * owner-gated calls (enableModule + assign/scope) can only be authorized by the
 * Safe owner. Since that owner is typically a hardware wallet with no pasteable
 * key, we PRINT the exact transactions for the user to execute in the Safe UI,
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
] as const

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
    return true
  } catch {
    return false
  }
}

function printOwnerCalls(
  safe: `0x${string}`,
  calls: ConfigureCall[],
  log: (line: string) => void,
): void {
  log('\n──────── Execute these from your Safe owner (app.safe.global) ────────')
  log(`Safe: ${safe}`)
  log('Open your Safe → New transaction → Transaction Builder. Add each call below')
  log('(paste To / Value / Data), or submit them individually, then execute:\n')
  calls.forEach((c, i) => {
    log(`  ${i + 1}. ${c.description}`)
    log(`     To:    ${c.to}`)
    log(`     Value: ${c.value.toString()}`)
    log(`     Data:  ${c.data}`)
  })
  log('──────────────────────────────────────────────────────────────────────\n')
}

export interface ConfigureExistingSafeParams {
  publicClient: PublicClient
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
  if (!rolesModifierAddress) {
    log('→ deploying a Roles v2 modifier for your Safe (bot pays gas)…')
    ;({ rolesModifierAddress } = await deployRolesModifier({
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

  const readyArgs = {
    safeAddress,
    rolesModifierAddress,
    botAddress: params.botAddress,
    roleKey: params.roleKey,
    poolAddress: params.poolAddress,
    poolId: params.poolId,
  }

  // 2. Idempotent: if the module is already enabled and this pool is scoped
  //    (add-pool re-run, or a resumed run after the owner executed), we're done.
  if (await scopeReady(publicClient, readyArgs)) {
    log('  ✓ Safe already enabled + loan-only scoped for this pool — nothing to submit.')
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
    includeEnableModule,
  })
  printOwnerCalls(safeAddress, calls, log)

  // 4. Poll until the owner has executed them (Roles scoping is additive, so an
  //    existing pool on this modifier/role stays scoped).
  for (;;) {
    await prompter.text(
      '  Press Enter once you have executed the transaction(s) in the Safe (I will re-check)',
    )
    if (await scopeReady(publicClient, readyArgs)) {
      await assertBotIsNotSafeOwner(publicClient, safeAddress, params.botAddress)
      log('  ✓ detected on-chain: module enabled + loan-only scope live.')
      return { safeAddress, rolesModifierAddress }
    }
    log('  … not detected yet (txs may still be pending, or not all executed). Re-checking…')
  }
}
