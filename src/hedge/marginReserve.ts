import { toVaultFrameAtTick } from '@panoptic-eng/sdk/v2'

export interface MarginSnapshot {
  collateralBalance0: bigint
  requiredCollateral0: bigint
  collateralBalance1: bigint
  requiredCollateral1: bigint
}

export interface MarginReserveAssessment {
  sufficient: boolean
  free0: bigint
  free1: bigint
  reasons: string[]
}

const BPS = 10_000n

export interface PostDispatchMarginState {
  collateral0: bigint
  collateral1: bigint
  marginExcess0: bigint
  marginExcess1: bigint
  tick: bigint
}

/**
 * Normalize native per-token post-dispatch margin into the same two equivalent
 * numeraires returned by `getAccountBuyingPower`.
 */
export function normalizePostDispatchMargin(state: PostDispatchMarginState): MarginSnapshot {
  const required0 = state.collateral0 - state.marginExcess0
  const required1 = state.collateral1 - state.marginExcess1

  return {
    collateralBalance0:
      state.collateral0 + toVaultFrameAtTick(state.collateral1, 1n, 0n, state.tick),
    requiredCollateral0: required0 + toVaultFrameAtTick(required1, 1n, 0n, state.tick),
    collateralBalance1:
      state.collateral1 + toVaultFrameAtTick(state.collateral0, 0n, 1n, state.tick),
    requiredCollateral1: required1 + toVaultFrameAtTick(required0, 0n, 1n, state.tick),
  }
}

/**
 * Enforce an operator reserve in both equivalent asset numeraires. A burn-only
 * dispatch is allowed to reduce risk; every dispatch containing a mint must
 * retain the configured fraction of gross collateral as free buying power.
 */
export function assessMarginReserve(
  snapshot: MarginSnapshot,
  reserveBps: bigint,
  containsMint: boolean,
): MarginReserveAssessment {
  const free0 =
    snapshot.collateralBalance0 > snapshot.requiredCollateral0
      ? snapshot.collateralBalance0 - snapshot.requiredCollateral0
      : 0n
  const free1 =
    snapshot.collateralBalance1 > snapshot.requiredCollateral1
      ? snapshot.collateralBalance1 - snapshot.requiredCollateral1
      : 0n
  if (!containsMint) return { sufficient: true, free0, free1, reasons: [] }

  const reasons: string[] = []
  if (
    snapshot.collateralBalance0 === 0n ||
    free0 * BPS < snapshot.collateralBalance0 * reserveBps
  ) {
    reasons.push(`token0 free collateral is below the ${reserveBps}bps reserve`)
  }
  if (
    snapshot.collateralBalance1 === 0n ||
    free1 * BPS < snapshot.collateralBalance1 * reserveBps
  ) {
    reasons.push(`token1 free collateral is below the ${reserveBps}bps reserve`)
  }
  return { sufficient: reasons.length === 0, free0, free1, reasons }
}
