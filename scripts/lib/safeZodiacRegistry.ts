import type { PublicClient } from 'viem'
import { getAddress, keccak256 } from 'viem'

/**
 * Chain-indexed Safe + Zodiac infrastructure the deploy path needs. These are
 * deterministic, deployer-independent deployments (Safe via the singleton
 * factory, Zodiac via the CREATE2 ModuleProxyFactory), so the same addresses
 * are reused across chains — but each entry is only added after verifying it
 * against the official Safe / Zodiac deployment listings for that chain.
 *
 * NOTE: kept local to the bot's ops tooling for now. If a second app needs
 * Safe/Zodiac addresses, promote this to `@panoptic-eng/sdk/zodiac` (which
 * already owns the Roles mastercopy constant in its docs).
 */
export interface SafeZodiacAddresses {
  /** Safe v1.4.1 SafeProxyFactory. */
  safeProxyFactory: `0x${string}`
  /** Safe v1.4.1 SafeL2 singleton (emits events for every tx — indexer-friendly). */
  safeSingleton: `0x${string}`
  /** Zodiac ModuleProxyFactory (deploys the Roles modifier proxy). */
  moduleProxyFactory: `0x${string}`
  /** Zodiac Roles Modifier v2.1 mastercopy. */
  rolesMastercopy: `0x${string}`
  /** Safe v1.4.1 MultiSendCallOnly — batches the configure step into one tx. */
  multiSend: `0x${string}`
}

/**
 * Zodiac Roles Modifier v2.1 mastercopy, documented in
 * `packages/sdk/src/zodiac` (constants.ts) and `packages/zodiac-modules` (README.md / ICustomCondition.sol)
 * and verified against the deployed bytecode. Deterministic across chains.
 */
export const ROLES_V2_1_MASTERCOPY = '0x9646fDAD06d3e24444381f44362a3B0eB343D337' as const

/** Safe v1.4.1 canonical deployments (identical on mainnet + base). */
const SAFE_V1_4_1_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const
const SAFE_V1_4_1_L2_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as const
/** Zodiac ModuleProxyFactory (CREATE2, identical on every chain). */
const ZODIAC_MODULE_PROXY_FACTORY = '0x000000000000aDdB49795b0f9bA5BC298cDda236' as const
/**
 * Safe v1.4.1 MultiSendCallOnly (CALL-only variant — rejects delegatecalls in
 * the batch, so the configure step can never smuggle a delegatecall). Canonical,
 * identical on mainnet + base; bytecode verified before wiring.
 */
const SAFE_V1_4_1_MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as const

const CANONICAL: SafeZodiacAddresses = {
  safeProxyFactory: SAFE_V1_4_1_PROXY_FACTORY,
  safeSingleton: SAFE_V1_4_1_L2_SINGLETON,
  moduleProxyFactory: ZODIAC_MODULE_PROXY_FACTORY,
  rolesMastercopy: ROLES_V2_1_MASTERCOPY,
  multiSend: SAFE_V1_4_1_MULTISEND_CALL_ONLY,
}

const CANONICAL_CODE_HASHES: Record<keyof SafeZodiacAddresses, `0x${string}`> = {
  // @safe-global/safe-deployments v1.4.1 canonical artifacts.
  safeProxyFactory: '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317',
  safeSingleton: '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff',
  multiSend: '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939',
  // gnosisguild/zodiac pinned deployment artifacts: ModuleProxyFactory 1.2.0
  // and Roles 2.1.0 respectively.
  moduleProxyFactory: '0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e',
  rolesMastercopy: '0x87911cbc6aa0496e6bcb07dab2462b9c76daea130dede6dcc57d0adf307fa7ec',
}

/**
 * Safe + Zodiac addresses keyed by chainId. Only chains listed here (plus any
 * fully env-overridden chain) can be onboarded without manual address entry.
 */
export const SAFE_ZODIAC_ADDRESSES: Record<number, SafeZodiacAddresses> = {
  // Ethereum mainnet
  1: { ...CANONICAL },
  // Base (8453) is intentionally NOT listed yet — not supported for onboarding.
  // The Safe/Zodiac addresses are canonical and identical there, so it can be
  // added back as `8453: { ...CANONICAL }` once Base is officially supported;
  // advanced users can meanwhile onboard it via the manual "other" chain path.
}

/** The env vars that override individual registry addresses. */
const ENV_OVERRIDES: Record<keyof SafeZodiacAddresses, string> = {
  safeProxyFactory: 'SAFE_PROXY_FACTORY',
  safeSingleton: 'SAFE_SINGLETON',
  moduleProxyFactory: 'ZODIAC_MODULE_PROXY_FACTORY',
  rolesMastercopy: 'ROLES_MASTERCOPY',
  multiSend: 'SAFE_MULTISEND',
}

export const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/** Find the first block containing code, avoiding unbounded full-history log scans. */
export async function findContractDeploymentBlock(
  client: PublicClient,
  address: `0x${string}`,
): Promise<bigint> {
  let low = 0n
  // cacheTime: 0 forces a fresh head read. viem caches getBlockNumber per
  // client, so a caller that fetched the height earlier (e.g. a reachability
  // probe) would otherwise hand us a stale height from BEFORE a just-deployed
  // contract existed — making the getCode-at-head check below spuriously fail.
  let high = await client.getBlockNumber({ cacheTime: 0 })
  const latestCode = await client.getCode({ address, blockNumber: high })
  if (!latestCode || latestCode === '0x') throw new Error(`no deployed code at ${address}`)
  while (low < high) {
    const middle = (low + high) / 2n
    const code = await client.getCode({ address, blockNumber: middle })
    if (code && code !== '0x') high = middle
    else low = middle + 1n
  }
  return low
}

/**
 * Resolve the Safe + Zodiac addresses for a chain, letting explicit overrides
 * win over the registry. Overrides come from `overrides` first, then the
 * matching env var (`SAFE_PROXY_FACTORY`, `SAFE_SINGLETON`,
 * `ZODIAC_MODULE_PROXY_FACTORY`, `ROLES_MASTERCOPY`).
 *
 * Throws with the missing field names if the chain is not in the registry and
 * an override does not supply every address.
 */
export function getSafeZodiacAddresses(
  chainId: number,
  overrides: Partial<SafeZodiacAddresses> = {},
  env: NodeJS.ProcessEnv = process.env,
): SafeZodiacAddresses {
  const base = SAFE_ZODIAC_ADDRESSES[chainId]
  const keys = Object.keys(ENV_OVERRIDES) as (keyof SafeZodiacAddresses)[]

  const resolved: Partial<SafeZodiacAddresses> = {}
  const missing: string[] = []
  const malformed: string[] = []

  for (const key of keys) {
    const envVar = ENV_OVERRIDES[key]
    const value = overrides[key] ?? (env[envVar] as `0x${string}` | undefined) ?? base?.[key]
    if (!value) {
      missing.push(envVar)
      continue
    }
    if (!ADDRESS_RE.test(value)) {
      malformed.push(`${envVar}=${value}`)
      continue
    }
    resolved[key] = getAddress(value)
  }

  if (chainId === 1) {
    const changed = keys.filter(
      (key) => resolved[key] && getAddress(resolved[key]) !== getAddress(CANONICAL[key]),
    )
    if (changed.length > 0) {
      throw new Error(
        `Canonical mainnet Safe/Zodiac addresses cannot be overridden: ${changed.join(', ')}`,
      )
    }
  }

  if (malformed.length > 0) {
    throw new Error(`Malformed Safe/Zodiac address override(s): ${malformed.join(', ')}`)
  }
  if (missing.length > 0) {
    throw new Error(
      `No Safe/Zodiac addresses for chain ${chainId} and no override for: ${missing.join(', ')}. ` +
        `Add the chain to SAFE_ZODIAC_ADDRESSES or set the env var(s).`,
    )
  }

  return resolved as SafeZodiacAddresses
}

/**
 * Assert every resolved address actually has bytecode on the target chain —
 * guards against a wrong-chain RPC or a typo before any state-changing deploy.
 */
export async function verifySafeZodiacBytecode(
  client: PublicClient,
  addrs: SafeZodiacAddresses,
): Promise<void> {
  const entries = Object.entries(addrs) as [keyof SafeZodiacAddresses, `0x${string}`][]
  const codes = await Promise.all(entries.map(([, address]) => client.getCode({ address })))
  const invalid = entries.flatMap(([name, address], index) => {
    const code = codes[index]
    if (!code || code === '0x') return [`${name} (${address}): no bytecode`]
    const actual = keccak256(code)
    return actual === CANONICAL_CODE_HASHES[name]
      ? []
      : [`${name} (${address}): code hash ${actual} is not the reviewed canonical hash`]
  })
  if (invalid.length > 0) {
    throw new Error(
      `Safe/Zodiac contract identity verification failed: ${invalid.join('; ')}. ` +
        `Do not onboard or activate against unreviewed implementations.`,
    )
  }
}

const safeProxyReadAbi = [
  {
    type: 'function',
    name: 'masterCopy',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const safeFactoryEvents = [
  {
    type: 'event',
    name: 'ProxyCreation',
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'singleton', type: 'address', indexed: false },
    ],
  },
] as const

const moduleFactoryEvents = [
  {
    type: 'event',
    name: 'ModuleProxyCreation',
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'masterCopy', type: 'address', indexed: true },
    ],
  },
] as const

/** Verify that the configured Safe and Roles proxy came from the reviewed factories/implementations. */
export async function verifySafeAndRolesProxyIdentities(
  client: PublicClient,
  addrs: SafeZodiacAddresses,
  safeAddress: `0x${string}`,
  rolesModifierAddress: `0x${string}`,
  // Known deployment blocks from the deploy tx receipts. When supplied, we skip
  // the numeric-block `getCode` discovery in findContractDeploymentBlock — anvil
  // forks serve that unreliably for locally-deployed contracts, whereas the
  // getLogs/readContract('latest') checks below work there. Real-RPC callers
  // (prod diagnostics) omit these and keep the discovery fallback.
  knownBlocks?: { safe?: bigint; roles?: bigint },
): Promise<void> {
  await verifySafeZodiacBytecode(client, addrs)

  const [safeDeploymentBlock, rolesDeploymentBlock] = await Promise.all([
    knownBlocks?.safe ?? findContractDeploymentBlock(client, safeAddress),
    knownBlocks?.roles ?? findContractDeploymentBlock(client, rolesModifierAddress),
  ])
  const [safeMasterCopy, safeCreation, rolesCreation, rolesCode] = await Promise.all([
    client.readContract({
      address: safeAddress,
      abi: safeProxyReadAbi,
      functionName: 'masterCopy',
    }),
    client.getLogs({
      address: addrs.safeProxyFactory,
      event: safeFactoryEvents[0],
      args: { proxy: safeAddress },
      fromBlock: safeDeploymentBlock,
      toBlock: 'latest',
      strict: true,
    }),
    client.getLogs({
      address: addrs.moduleProxyFactory,
      event: moduleFactoryEvents[0],
      args: { proxy: rolesModifierAddress, masterCopy: addrs.rolesMastercopy },
      fromBlock: rolesDeploymentBlock,
      toBlock: 'latest',
      strict: true,
    }),
    client.getCode({ address: rolesModifierAddress }),
  ])

  if (getAddress(safeMasterCopy) !== getAddress(addrs.safeSingleton) || safeCreation.length !== 1) {
    throw new Error('configured Safe is not a unique proxy of the reviewed canonical singleton')
  }
  if (getAddress(safeCreation[0].args.singleton) !== getAddress(addrs.safeSingleton)) {
    throw new Error('configured Safe factory event names an unreviewed singleton')
  }
  if (rolesCreation.length !== 1) {
    throw new Error('configured Roles modifier is not a unique proxy of the reviewed mastercopy')
  }

  const expectedRolesProxy =
    `0x363d3d373d3d3d363d73${addrs.rolesMastercopy.slice(2).toLowerCase()}` +
    '5af43d82803e903d91602b57fd5bf3'
  if (rolesCode?.toLowerCase() !== expectedRolesProxy) {
    throw new Error('configured Roles proxy runtime does not embed the reviewed mastercopy')
  }
}
