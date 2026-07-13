/**
 * Parse the optional PANOPTIC_BUILDER_CODE env value into a uint256 bigint.
 * Missing / blank / invalid values resolve to 0n (no builder code).
 */
export function parseBuilderCode(raw: string | undefined): bigint {
  if (!raw || raw.trim() === '') return 0n
  try {
    const value = BigInt(raw.trim())
    return value < 0n ? 0n : value
  } catch {
    return 0n
  }
}
