import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  getCreate2Address,
  keccak256,
  pad,
  toHex,
} from 'viem'

/**
 * Vanity-address mining for the Safe deployed by the onboard wizard.
 *
 * The Safe is a CREATE2 proxy from the Safe v1.4.1 `SafeProxyFactory`
 * (`createProxyWithNonce(singleton, initializer, saltNonce)`), so its address is
 * a pure function of `saltNonce` once the deployer (owner) and chain are fixed.
 * We can therefore search `saltNonce` values locally — no chain writes — until
 * the predicted address starts with a chosen hex prefix, then hand that salt to
 * `deploySafeAndRoles`.
 *
 * Factory address derivation (matches SafeProxyFactory.deployProxy):
 *   salt         = keccak256( keccak256(initializer) ++ bytes32(saltNonce) )
 *   deployment   = proxyCreationCode ++ uint256(uint160(singleton))
 *   proxy        = CREATE2(factory, salt, keccak256(deployment))
 */

const safeProxyFactoryReadAbi = [
  {
    type: 'function',
    name: 'proxyCreationCode',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

/** Fetch the factory's SafeProxy creation code (the CREATE2 init-code prefix). */
export async function fetchProxyCreationCode(client: PublicClient, factory: Address): Promise<Hex> {
  return (await client.readContract({
    address: factory,
    abi: safeProxyFactoryReadAbi,
    functionName: 'proxyCreationCode',
  })) as Hex
}

export interface SafeAddressPredictorParams {
  factory: Address
  singleton: Address
  /** The exact `setup(...)` initializer bytes passed to createProxyWithNonce. */
  initializer: Hex
  /** Result of `fetchProxyCreationCode`. */
  proxyCreationCode: Hex
}

/**
 * Build a fast `saltNonce -> Safe address` predictor. The initializer hash and
 * the CREATE2 init-code hash are constant across salts, so they are computed
 * once here and reused per attempt (only one keccak per salt in the hot loop).
 */
export function makeSafeAddressPredictor(
  params: SafeAddressPredictorParams,
): (saltNonce: bigint) => Address {
  const { factory, singleton, initializer, proxyCreationCode } = params
  const initializerHash = keccak256(initializer)
  // deploymentData = proxyCreationCode ++ uint256(uint160(singleton))
  const bytecodeHash = keccak256(concatHex([proxyCreationCode, pad(singleton, { size: 32 })]))
  return (saltNonce: bigint): Address => {
    const salt = keccak256(concatHex([initializerHash, toHex(saltNonce, { size: 32 })]))
    return getCreate2Address({ from: factory, salt, bytecodeHash })
  }
}

/** Normalise a user-typed vanity prefix to lowercase hex (no `0x`). */
export function normalizeVanityPrefix(input: string): string {
  return input.trim().replace(/^0x/i, '').toLowerCase()
}

/** Validate a vanity prefix: hex only. Returns an error string or undefined. */
export function validateVanityPrefix(input: string, maxLen = 8): string | undefined {
  const p = normalizeVanityPrefix(input)
  if (p.length === 0) return 'enter at least one hex character (0-9, a-f)'
  if (p.length > maxLen) return `at most ${maxLen} characters (longer prefixes take too long)`
  if (!/^[0-9a-f]+$/.test(p)) return 'hex characters only (0-9, a-f)'
  return undefined
}

/** Expected number of attempts to hit an n-nibble prefix (16^n). */
export function expectedAttempts(prefixLen: number): number {
  return 16 ** prefixLen
}

export interface MineVanityParams extends SafeAddressPredictorParams {
  /** Desired address prefix (hex, no `0x`, lowercase). */
  prefix: string
  /** First saltNonce to try; the search increments from here. */
  start: bigint
  /** Give up after this many attempts (throws). Default 200x the expectation. */
  maxAttempts?: number
  /** Called roughly every `progressEvery` attempts with (attempts, current salt). */
  onProgress?: (attempts: number, salt: bigint) => void
  progressEvery?: number
}

export interface MineVanityResult {
  saltNonce: bigint
  address: Address
  attempts: number
}

/**
 * Search saltNonce values from `start` upward until the predicted Safe address
 * begins with `prefix`. Yields to the event loop periodically so progress can
 * be logged and Ctrl-C stays responsive. Throws if `maxAttempts` is exceeded.
 */
export async function mineVanitySafeSalt(params: MineVanityParams): Promise<MineVanityResult> {
  const prefix = normalizeVanityPrefix(params.prefix)
  // Fail fast on a non-hex / over-long prefix before sizing the search or mining.
  const prefixError = validateVanityPrefix(prefix)
  if (prefixError) throw new Error(`invalid vanity prefix: ${prefixError}`)
  const predict = makeSafeAddressPredictor(params)
  const progressEvery = params.progressEvery ?? 20_000
  const maxAttempts =
    params.maxAttempts ?? Math.max(1_000_000, expectedAttempts(prefix.length) * 200)

  let salt = params.start
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const address = predict(salt)
    // address is `0x` + 40 hex chars; compare the leading nibbles, case-insensitively.
    if (address.slice(2, 2 + prefix.length).toLowerCase() === prefix) {
      return { saltNonce: salt, address, attempts }
    }
    if (attempts % progressEvery === 0) {
      params.onProgress?.(attempts, salt)
      // Release the event loop so logs flush and SIGINT is handled.
      await new Promise((resolve) => setImmediate(resolve))
    }
    salt += 1n
  }
  throw new Error(
    `no vanity match for prefix "0x${prefix}" after ${maxAttempts.toLocaleString()} attempts`,
  )
}
