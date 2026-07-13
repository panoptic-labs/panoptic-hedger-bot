import type { PublicClient } from 'viem'
import { getAddress } from 'viem'

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
  const empty = entries
    .filter((_, i) => !codes[i] || codes[i] === '0x')
    .map(([name, address]) => `${name} (${address})`)
  if (empty.length > 0) {
    throw new Error(
      `Safe/Zodiac contract(s) have no bytecode on this chain: ${empty.join(', ')}. ` +
        `Is the RPC pointed at the right chain, or are these addresses correct?`,
    )
  }
}
