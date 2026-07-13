import { type PositionSnapshot, isLoanPosition } from './frame'

/**
 * Tracks the set of hedge-loan tokenIds the bot has opened. Held in memory for
 * v1; on restart it is re-derived from the Safe's width=0 loan positions.
 */
export class HedgeTracker {
  private ids: Set<bigint>

  constructor(initial: Iterable<bigint> = []) {
    this.ids = new Set(initial)
  }

  get size(): number {
    return this.ids.size
  }

  snapshot(): Set<bigint> {
    return new Set(this.ids)
  }

  has(id: bigint): boolean {
    return this.ids.has(id)
  }

  /**
   * Reconcile against the on-chain position list. Drops tracked ids that are no
   * longer open (burned outside the bot / settled), and — when nothing is
   * tracked yet — seeds from every pure loan position (restart recovery).
   */
  reconcile(positions: PositionSnapshot[]): void {
    const openIds = new Set(positions.map((p) => p.tokenId))
    for (const id of this.ids) {
      if (!openIds.has(id)) this.ids.delete(id)
    }
    if (this.ids.size === 0) {
      for (const p of positions) {
        if (isLoanPosition(p.legs)) this.ids.add(p.tokenId)
      }
    }
  }

  /** Apply the result of a dispatch: remove burned ids, add the newly minted id. */
  applyResult(closedTokenIds: Iterable<bigint>, openedTokenId: bigint | null): void {
    for (const id of closedTokenIds) this.ids.delete(id)
    if (openedTokenId !== null) this.ids.add(openedTokenId)
  }
}
