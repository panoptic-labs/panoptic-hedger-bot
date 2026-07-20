import {
  type ScopeStep,
  buildDeleveragerRoleSteps,
  buildLoanOnlyDispatchConditions,
  buildMaintenanceRoleSteps,
  buildRollerRoleSteps,
  buildSizeAdjusterRoleSteps,
  CANONICAL_ADAPTERS,
  rolesV2Abi,
} from '@panoptic-eng/sdk/zodiac'
import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem'
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
  zeroAddress,
} from 'viem'

import { type MultiSendCall, encodeMultiSend } from '../../src/executor/multiSend'
import {
  assertBotIsNotSafeOwner,
  assertPlannedSafeOwnerIsNotBot,
} from '../../src/security/safeOwnerInvariant'
import { execFromSoleOwner } from './safeExec'
import type { SafeZodiacAddresses } from './safeZodiacRegistry'
import { type FeeOptions, hasCode, resolveTxFees, waitForReceiptResilient } from './txWait'

/**
 * Core (env-free, side-effect-free besides the chain writes it is asked to do)
 * deploy + scope logic for the hedger-bot's Safe + Zodiac Roles infrastructure.
 * Shared by the `setup` wizard and the legacy `deploy:safe-roles` script so the
 * viem calls live in exactly one place.
 *
 * ⚠️  OPS TOOLING — NOT UNIT-TESTED against a live Roles modifier. Exercised by
 *     scripts/setup.fork.test.ts against an anvil fork. Run against a fork and
 *     assert the end state before touching a real network.
 */

export const DISPATCH_SELECTOR = toFunctionSelector(
  'dispatch(uint256[],uint256[],uint128[],int24[3][],bool,uint256)',
)
const EXEC_OPTIONS_NONE = 0 // plain call, no value / no delegatecall
/** Safe owner linked-list sentinel (prevOwner of the sole owner). */
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001' as const

const safeAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'enableModule',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isModuleEnabled',
    stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'swapOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'prevOwner', type: 'address' },
      { name: 'oldOwner', type: 'address' },
      { name: 'newOwner', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

const safeProxyFactoryAbi = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
  {
    type: 'event',
    name: 'ProxyCreation',
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'singleton', type: 'address', indexed: false },
    ],
  },
] as const

const moduleProxyFactoryAbi = [
  {
    type: 'function',
    name: 'deployModule',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'masterCopy', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
  {
    type: 'event',
    name: 'ModuleProxyCreation',
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'masterCopy', type: 'address', indexed: true },
    ],
  },
] as const

const rolesSetUpAbi = [
  {
    type: 'function',
    name: 'setUp',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'initParams', type: 'bytes' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transferOwnership',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newOwner', type: 'address' }],
    outputs: [],
  },
] as const

/**
 * Encode the Safe `setup` initializer used at proxy creation: a single owner
 * (the deployer), threshold 1, and no module/fallback/payment. This is the
 * `initializer` byte-string passed to `createProxyWithNonce`, so it must stay
 * byte-identical to the deploy call for CREATE2 address prediction (see
 * lib/vanitySafe.ts) to match the address the factory actually produces.
 */
export function buildSafeSetupInitializer(owner: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [[owner], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress],
  })
}

/** An à-la-carte keeper role to additionally scope onto the Safe. */
export type ExtraRoleKind = 'deleverager' | 'maintenance' | 'roller' | 'size-adjuster'

export interface ExtraRoleSpec {
  kind: ExtraRoleKind
  /** EOA assigned to the role (often a separate keeper, not the hedger bot). */
  member: `0x${string}`
  /** roller / size-adjuster only: reopen size cap (0n = uncapped). */
  sizeCap?: bigint
}

/** Build the Roles scope steps for an extra role, given the deployed Safe. */
function buildExtraRoleSteps(
  spec: ExtraRoleSpec,
  pool: `0x${string}`,
  safe: `0x${string}`,
): ScopeStep[] {
  switch (spec.kind) {
    case 'deleverager':
      return buildDeleveragerRoleSteps({ member: spec.member, pool })
    case 'maintenance':
      return buildMaintenanceRoleSteps({ member: spec.member, pool, safe })
    case 'roller':
      return buildRollerRoleSteps({
        member: spec.member,
        pool,
        adapter: CANONICAL_ADAPTERS.RollerCondition,
        sizeCap: spec.sizeCap,
      })
    case 'size-adjuster':
      return buildSizeAdjusterRoleSteps({
        member: spec.member,
        pool,
        adapter: CANONICAL_ADAPTERS.SizeAdjusterCondition,
        sizeCap: spec.sizeCap,
      })
  }
}

/** Send one deployer-EOA tx with a non-zero priority tip and a resilient wait. */
async function sendResilientTx(opts: {
  publicClient: PublicClient
  walletClient: WalletClient<Transport, Chain, Account>
  address: `0x${string}`
  abi: unknown
  functionName: string
  args: unknown[]
  feeOptions?: FeeOptions
  timeoutMs?: number
  log: (line: string) => void
}) {
  const fees = await resolveTxFees(opts.publicClient, opts.feeOptions)
  const hash = await opts.walletClient.writeContract({
    account: opts.walletClient.account,
    chain: opts.walletClient.chain,
    address: opts.address,
    abi: opts.abi as never,
    functionName: opts.functionName as never,
    args: opts.args as never,
    ...fees,
  })
  const receipt = await waitForReceiptResilient(opts.publicClient, hash, {
    timeoutMs: opts.timeoutMs,
    log: opts.log,
  })
  if (receipt.status !== 'success') {
    throw new Error(`${opts.functionName} reverted (tx ${hash}, status ${receipt.status})`)
  }
  return receipt
}

/**
 * Deploy a Zodiac Roles v2 modifier proxy with owner = avatar = target = the
 * given Safe. `deployModule` is permissionless, so ANY funded EOA (the bot) can
 * send this — no Safe-owner authorization needed. Used by the fresh-deploy flow
 * and by the existing-Safe onboarding path (which then hands the owner-gated
 * enable/scope calls to the Safe owner to execute).
 */
export async function deployRolesModifier(params: {
  publicClient: PublicClient
  walletClient: WalletClient<Transport, Chain, Account>
  addresses: SafeZodiacAddresses
  safeAddress: `0x${string}`
  saltNonce: bigint
  feeOptions?: FeeOptions
  timeoutMs?: number
  log?: (line: string) => void
}): Promise<{
  rolesModifierAddress: `0x${string}`
  deploymentBlock: bigint
  transactionHash: `0x${string}`
}> {
  const { publicClient, walletClient, addresses, safeAddress, saltNonce } = params
  const log = params.log ?? console.log
  const rolesInit = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [safeAddress, safeAddress, safeAddress],
  )
  const rolesSetUp = encodeFunctionData({
    abi: rolesSetUpAbi,
    functionName: 'setUp',
    args: [rolesInit],
  })
  const receipt = await sendResilientTx({
    publicClient,
    walletClient,
    address: addresses.moduleProxyFactory,
    abi: moduleProxyFactoryAbi,
    functionName: 'deployModule',
    args: [addresses.rolesMastercopy, rolesSetUp, saltNonce],
    feeOptions: params.feeOptions,
    timeoutMs: params.timeoutMs,
    log,
  })
  const rolesModifierAddress = extractEventAddress(
    receipt.logs,
    moduleProxyFactoryAbi,
    'ModuleProxyCreation',
    'proxy',
  )
  return {
    rolesModifierAddress,
    deploymentBlock: receipt.blockNumber,
    transactionHash: receipt.transactionHash,
  }
}

/** One owner-authorized configuration call, with a human-readable summary. */
export interface ConfigureCall {
  /** Summary for the Safe-UI print path (existing-Safe onboarding). */
  description: string
  to: `0x${string}`
  value: bigint
  data: `0x${string}`
}

/**
 * Build the ordered owner-authorized calls that wire a Roles modifier to a Safe
 * for loan-only hedging: (optional) `enableModule`, then `assignRoles`,
 * `scopeTarget`, `scopeFunction` [+ extra-role steps] [+ optional `swapOwner`].
 *
 * Every call must run with `msg.sender == Safe` (module-enable is self-auth;
 * the Roles admin calls are onlyOwner == Safe). The fresh-deploy flow batches
 * these through a 1-of-1 Safe it transiently owns; the existing-Safe flow prints
 * them for the real owner to execute in the Safe UI.
 */
export function buildConfigureCalls(params: {
  safeAddress: `0x${string}`
  rolesModifierAddress: `0x${string}`
  botAddress: `0x${string}`
  roleKey: `0x${string}`
  poolAddress: `0x${string}`
  extraRoles?: ExtraRoleSpec[]
  /** Prepend `enableModule` (skip when the module is already enabled). */
  includeEnableModule: boolean
  /** Fresh deploy only: append `swapOwner` removing this deployer for finalSafeOwner. */
  swapOwnerFrom?: `0x${string}`
  finalSafeOwner?: `0x${string}`
}): ConfigureCall[] {
  const { safeAddress, rolesModifierAddress, botAddress, roleKey, poolAddress } = params
  const extraRoles = params.extraRoles ?? []
  const calls: ConfigureCall[] = []

  if (params.includeEnableModule) {
    calls.push({
      description: `enableModule(${rolesModifierAddress}) on the Safe`,
      to: safeAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: 'enableModule',
        args: [rolesModifierAddress],
      }),
    })
  }

  const steps: ScopeStep[] = [
    {
      name: 'assignRoles(bot)',
      functionName: 'assignRoles',
      args: [botAddress, [roleKey], [true]],
    },
    { name: 'scopeTarget(pool)', functionName: 'scopeTarget', args: [roleKey, poolAddress] },
    {
      name: 'scopeFunction(dispatch, loan-only)',
      functionName: 'scopeFunction',
      args: [
        roleKey,
        poolAddress,
        DISPATCH_SELECTOR,
        buildLoanOnlyDispatchConditions(),
        EXEC_OPTIONS_NONE,
      ],
    },
  ]
  for (const spec of extraRoles) steps.push(...buildExtraRoleSteps(spec, poolAddress, safeAddress))
  for (const step of steps) {
    calls.push({
      description: `${step.name} on the Roles modifier`,
      to: rolesModifierAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: rolesV2Abi,
        functionName: step.functionName,
        args: step.args as never,
      }),
    })
  }

  if (
    params.swapOwnerFrom &&
    params.finalSafeOwner &&
    getAddress(params.finalSafeOwner) !== getAddress(params.swapOwnerFrom)
  ) {
    calls.push({
      description: `swapOwner → ${params.finalSafeOwner} on the Safe`,
      to: safeAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: 'swapOwner',
        args: [SENTINEL_OWNERS, params.swapOwnerFrom, params.finalSafeOwner],
      }),
    })
  }

  return calls
}

export interface DeploySafeAndRolesParams {
  publicClient: PublicClient
  /** Deployer wallet — becomes the Safe owner; scopes the Roles modifier, then
   * hands its ownership to the Safe. */
  walletClient: WalletClient<Transport, Chain, Account>
  /** Bot EOA to assign to the loan-only role. */
  botAddress: `0x${string}`
  /** PanopticPool holding the options + hedge loans. */
  poolAddress: `0x${string}`
  /** bytes32 role key for the bot. */
  roleKey: `0x${string}`
  /** Safe + Zodiac infrastructure addresses (from the registry). */
  addresses: SafeZodiacAddresses
  /** CREATE2 salt — use a fresh value per deployment to avoid collisions. */
  saltNonce: bigint
  /** Optional extra keeper roles to scope (deleverager/maintenance/roller/size-adjuster). */
  extraRoles?: ExtraRoleSpec[]
  /**
   * Optional EOA to hand Safe ownership to at the end (dropping the deployer).
   * Lets a throwaway burner deploy + pay gas while the real owner — e.g. a
   * hardware wallet — never exposes a private key. Omit to keep the deployer.
   */
  finalSafeOwner?: `0x${string}`
  /** EIP-1559 fee overrides (priority-tip floor etc). Applied to every tx. */
  feeOptions?: FeeOptions
  /** Receipt-wait timeout (ms) per tx. Defaults to txWait's 180s. */
  timeoutMs?: number
  /**
   * Addresses already deployed by a previous (interrupted) run, for resume.
   * A step whose contract already has code / whose end-state already holds is
   * skipped, making a re-run against a half-finished deploy a safe no-op.
   */
  known?: { safeAddress?: `0x${string}`; rolesModifierAddress?: `0x${string}` }
  /**
   * Invoked right after each contract is deployed, so the caller can persist the
   * address (e.g. to deploy-state.json) and resume if a later step fails.
   */
  onDeployed?: (partial: {
    safeAddress?: `0x${string}`
    rolesModifierAddress?: `0x${string}`
  }) => void | Promise<void>
  log?: (line: string) => void
}

export interface DeploySafeAndRolesResult {
  safeAddress: `0x${string}`
  rolesModifierAddress: `0x${string}`
  roleKey: `0x${string}`
  /** Final Safe owner (finalSafeOwner if handed off, else the deployer). */
  safeOwner: `0x${string}`
  /**
   * Block the Safe proxy was deployed in, from the deploy tx receipt. Lets
   * callers verify identity via event logs without re-discovering the block
   * through a numeric-block `getCode` scan (which anvil forks serve unreliably
   * for locally-deployed contracts). Undefined when the Safe was resumed from a
   * prior run (no fresh receipt this call).
   */
  safeDeploymentBlock?: bigint
  /** Block the Roles modifier proxy was deployed in. Undefined on resume. */
  rolesDeploymentBlock?: bigint
  /** Tx hash of the Safe deploy. Undefined when the Safe was resumed/skipped. */
  safeTxHash?: `0x${string}`
  /** Tx hash of the Roles modifier deploy. Undefined on resume/skip. */
  rolesTxHash?: `0x${string}`
  /** Tx hash of the single configure (enable + scope + handoff). Undefined on resume/skip. */
  configureTxHash?: `0x${string}`
}

/**
/** Minimal read ABI for the Zodiac Roles ownership/avatar views. */
const rolesOwnershipReadAbi = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'avatar',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

/**
 * On resume, presence of bytecode alone doesn't prove the persisted address is
 * OUR Roles modifier for THIS Safe. Confirm `owner()` and `avatar()` both point
 * at the Safe (they are set to the Safe at deploy); a failed read or mismatch
 * means the address is stale/wrong and we should redeploy.
 */
async function isRolesModifierForSafe(
  publicClient: PublicClient,
  rolesModifier: `0x${string}`,
  safeAddress: `0x${string}`,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const [owner, avatar] = await Promise.all([
      publicClient.readContract({
        address: rolesModifier,
        abi: rolesOwnershipReadAbi,
        functionName: 'owner',
      }),
      publicClient.readContract({
        address: rolesModifier,
        abi: rolesOwnershipReadAbi,
        functionName: 'avatar',
      }),
    ])
    const matches =
      owner.toLowerCase() === safeAddress.toLowerCase() &&
      avatar.toLowerCase() === safeAddress.toLowerCase()
    if (!matches) {
      log(`  ⚠️  Roles modifier ${rolesModifier} owner/avatar ≠ Safe — redeploying`)
    }
    return matches
  } catch {
    log(`  ⚠️  Roles modifier ${rolesModifier} read failed — redeploying`)
    return false
  }
}

/**
 * Deploy a fresh Safe (owner = deployer, threshold 1), deploy + enable a Zodiac
 * Roles v2 modifier (owner/avatar/target = the Safe), and assign + scope the
 * bot EOA to loan-only `dispatch`. Aborts on the first reverting step.
 */
export async function deploySafeAndRoles(
  params: DeploySafeAndRolesParams,
): Promise<DeploySafeAndRolesResult> {
  const { publicClient, walletClient, botAddress, poolAddress, roleKey, addresses, saltNonce } =
    params
  const extraRoles = params.extraRoles ?? []
  const finalSafeOwner = params.finalSafeOwner
  const log = params.log ?? console.log
  const deployer = walletClient.account
  const { feeOptions, timeoutMs } = params
  const known = params.known ?? {}

  if (finalSafeOwner) assertPlannedSafeOwnerIsNotBot(finalSafeOwner, botAddress)
  if (!finalSafeOwner) assertPlannedSafeOwnerIsNotBot(deployer.address, botAddress)

  // A single deployer-EOA transaction: non-zero priority tip + resilient wait.
  const write = (address: `0x${string}`, abi: unknown, functionName: string, args: unknown[]) =>
    sendResilientTx({
      publicClient,
      walletClient,
      address,
      abi,
      functionName,
      args,
      feeOptions,
      timeoutMs,
      log,
    })

  // 1. Deploy the Safe (owner = deployer, threshold 1). Skipped on resume if the
  //    address from a prior run already has code.
  let safeAddress = known.safeAddress
  let safeDeploymentBlock: bigint | undefined
  let safeTxHash: `0x${string}` | undefined
  if (safeAddress && (await hasCode(publicClient, safeAddress))) {
    log(`→ Safe already deployed (${safeAddress}) — skipping`)
  } else {
    log('→ deploy Safe')
    const safeSetup = buildSafeSetupInitializer(deployer.address)
    const safeReceipt = await write(
      addresses.safeProxyFactory,
      safeProxyFactoryAbi,
      'createProxyWithNonce',
      [addresses.safeSingleton, safeSetup, saltNonce],
    )
    safeAddress = extractEventAddress(
      safeReceipt.logs,
      safeProxyFactoryAbi,
      'ProxyCreation',
      'proxy',
    )
    safeDeploymentBlock = safeReceipt.blockNumber
    safeTxHash = safeReceipt.transactionHash
    log(`  ✓ Safe: ${safeAddress}`)
    log(`    tx: ${safeTxHash}`)
    await params.onDeployed?.({ safeAddress })
  }

  // 2. Deploy the Roles v2 modifier (owner = avatar = target = the Safe). Setting
  //    the OWNER to the Safe from birth means all scoping is done through the Safe
  //    (step 3) and there is no separate transferOwnership tx to send.
  let rolesModifierAddress = known.rolesModifierAddress
  let rolesDeploymentBlock: bigint | undefined
  let rolesTxHash: `0x${string}` | undefined
  if (
    rolesModifierAddress &&
    safeAddress &&
    (await hasCode(publicClient, rolesModifierAddress)) &&
    (await isRolesModifierForSafe(publicClient, rolesModifierAddress, safeAddress, log))
  ) {
    log(`→ Roles modifier already deployed (${rolesModifierAddress}) — skipping`)
  } else {
    log('→ deploy Roles modifier (owner = Safe)')
    ;({
      rolesModifierAddress,
      deploymentBlock: rolesDeploymentBlock,
      transactionHash: rolesTxHash,
    } = await deployRolesModifier({
      publicClient,
      walletClient,
      addresses,
      safeAddress,
      saltNonce,
      feeOptions,
      timeoutMs,
      log,
    }))
    log(`  ✓ Roles: ${rolesModifierAddress}`)
    log(`    tx: ${rolesTxHash}`)
    await params.onDeployed?.({ rolesModifierAddress })
  }

  if (!safeAddress || !rolesModifierAddress) {
    throw new Error('internal: Safe/Roles address missing after deploy')
  }

  // 3. Configure everything in ONE Safe transaction: a delegatecall to
  //    MultiSendCallOnly batching enableModule + assign/scope + (optional) the
  //    Safe-ownership hand-off. Each inner CALL runs with msg.sender == Safe, so
  //    the module-enable, the onlyOwner Roles admin calls, and swapOwner all pass.
  //    One tx ⇒ one confirmation wait, and it is atomic (all-or-nothing), so no
  //    partial-scope state can be left behind.
  const enabled = (await publicClient.readContract({
    address: safeAddress,
    abi: safeAbi,
    functionName: 'isModuleEnabled',
    args: [rolesModifierAddress],
  })) as boolean
  let configureTxHash: `0x${string}` | undefined
  if (enabled) {
    // The batch is atomic: if the module is enabled, the whole configure step
    // already landed (this is the resume path for a tx that confirmed after the
    // client timed out). Nothing more to send.
    log('→ configuration already applied (module enabled) — skipping')
  } else {
    // Batch enable-module + assign/scope (+ optional ownership hand-off) as a
    // delegatecall to MultiSend, run atomically through the 1-of-1 Safe the
    // deployer transiently owns. swapOwner is appended LAST so every earlier
    // call still runs under the deployer's pre-validated session.
    const configureCalls = buildConfigureCalls({
      safeAddress,
      rolesModifierAddress,
      botAddress,
      roleKey,
      poolAddress,
      extraRoles,
      includeEnableModule: true,
      swapOwnerFrom: deployer.address,
      finalSafeOwner,
    })
    const calls: MultiSendCall[] = configureCalls.map((c) => ({
      to: c.to,
      value: c.value,
      data: c.data,
    }))

    log(
      `→ configure Safe in one tx: enable module + assign/scope role` +
        `${extraRoles.length ? ` (+${extraRoles.length} extra)` : ''}` +
        `${finalSafeOwner ? ' + hand off ownership' : ''}`,
    )
    configureTxHash = await execFromSoleOwner({
      publicClient,
      walletClient,
      safeAddress,
      to: addresses.multiSend,
      data: encodeMultiSend(calls),
      operation: 1, // delegatecall into MultiSend
      feeOptions,
      timeoutMs,
      simulate: true, // dry-run first so a bad scope reverts locally, not on-chain
      log,
    })
    log(
      `  ✓ configured Safe (module + loan-only scope${finalSafeOwner ? ' + ownership hand-off' : ''})`,
    )
    log(`    tx: ${configureTxHash}`)
  }

  await assertBotIsNotSafeOwner(publicClient, safeAddress, botAddress)

  return {
    safeAddress,
    rolesModifierAddress,
    roleKey,
    safeOwner: finalSafeOwner ?? deployer.address,
    safeDeploymentBlock,
    rolesDeploymentBlock,
    safeTxHash,
    rolesTxHash,
    configureTxHash,
  }
}

export function extractEventAddress(
  logs: readonly { data: `0x${string}`; topics: readonly `0x${string}`[] }[],
  abi: unknown,
  eventName: string,
  field: string,
): `0x${string}` {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: abi as never,
        data: log.data,
        topics: log.topics as never,
      })
      if (decoded.eventName === eventName) {
        return (decoded.args as unknown as Record<string, `0x${string}`>)[field]
      }
    } catch {
      // not this event
    }
  }
  throw new Error(`could not find ${eventName} in logs`)
}
