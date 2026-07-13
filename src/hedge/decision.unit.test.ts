import { describe, expect, it } from 'vitest'

import { type HedgeItem, type PlanHedgeConfig, planHedge } from './decision'

// assetIndex = 1n → short hedge tokenType = 1n (asset), long hedge tokenType = 0n (numeraire).
const CFG: PlanHedgeConfig = { assetIndex: 1n, deltaThresholdBps: 200n, absoluteMaxHedgeCount: 4 }
const PORT = 10_000n
const SHORT = 1n
const LONG = 0n

const short = (tokenId: bigint, size: bigint): HedgeItem => ({ tokenId, tokenType: SHORT, size })
const long = (tokenId: bigint, size: bigint): HedgeItem => ({ tokenId, tokenType: LONG, size })

describe('planHedge — gating', () => {
  it('no action when drift is below threshold and no other trigger', () => {
    // netDelta 100 / 10000 = 100bps < 200
    const r = planHedge(100n, 0n, 0n, [], PORT, CFG)
    expect(r.action).toBe('none')
    expect(r.triggers).toEqual({ drift: false, overCap: false, signFlip: false })
  })

  it('no action when portfolio size is zero and no hedges exist', () => {
    // sizeBasis falls back to the gross hedge book, which is also 0 here → none.
    expect(planHedge(9999n, 0n, 0n, [], 0n, CFG).action).toBe('none')
  })

  it('empty option book + standalone short loan → SHRINK toward H*', () => {
    // Live repro: option closed, one short loan H=-545, netDelta -392 (wallet ETH
    // + loan debt). portfolioSize=0 falls back to gross hedge book (545) → drift
    // 392/545 ≈ 7192bps ≫ 200 → shrink the loan to |H*| = 153.
    const r = planHedge(-392n, 545n, 0n, [short(1n, 545n)], 0n, CFG)
    expect(r.action).toBe('shrink')
    expect(r.Hstar).toBe(-153n)
    expect(r.driftBps).toBe(7192n)
    expect(r.burns).toEqual([1n])
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 153n }])
  })

  it('empty option book + loan exactly offsetting net delta → CLOSE_ALL', () => {
    const r = planHedge(-545n, 545n, 0n, [short(1n, 545n)], 0n, CFG)
    expect(r.action).toBe('close_all')
    expect(r.Hstar).toBe(0n)
    expect(r.burns).toEqual([1n])
    expect(r.mints).toEqual([])
  })
})

describe('planHedge — 5-case tree', () => {
  it('Case A OPEN: no hedges, positive net delta → short hedge sized |H*|', () => {
    const r = planHedge(1000n, 0n, 0n, [], PORT, CFG)
    expect(r.action).toBe('open')
    expect(r.H).toBe(0n)
    expect(r.Hstar).toBe(-1000n)
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 1000n }])
    expect(r.burns).toEqual([])
    expect(r.swapAtMint).toBe(true)
  })

  it('Case B CLOSE_ALL: hedge exactly equals net delta → burn all', () => {
    const r = planHedge(-1000n, 1000n, 0n, [short(1n, 1000n)], PORT, CFG)
    expect(r.action).toBe('close_all')
    expect(r.Hstar).toBe(0n)
    expect(r.burns).toEqual([1n])
    expect(r.mints).toEqual([])
    expect(r.swapAtMint).toBe(true)
  })

  it('Case C GROW: same-side, need more → one incremental same-side mint', () => {
    // H = -400 (short 400), netDelta +1000 → H* = -1400
    const r = planHedge(1000n, 400n, 0n, [short(1n, 400n)], PORT, CFG)
    expect(r.action).toBe('grow')
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 1000n }]) // |H*|-|H| = 1400-400
    expect(r.burns).toEqual([])
    expect(r.swapAtMint).toBe(true)
  })

  it('Case D SHRINK: same-side, need less → burn + partial remint', () => {
    // H = -1000 (short 1000), netDelta -600 → H* = -400, remove 600
    const r = planHedge(-600n, 1000n, 0n, [short(1n, 1000n)], PORT, CFG)
    expect(r.action).toBe('shrink')
    expect(r.burns).toEqual([1n])
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 400n }]) // 1000 - 600
    expect(r.swapAtMint).toBe(true)
  })

  it('Case D SHRINK: exact match burns only the smallest, no remint', () => {
    // two short hedges 200 + 400 = 600 (H=-600), netDelta -200 → H*=-400, remove 200.
    // Smaller portfolio (5000) so 200/5000 = 400bps clears the drift threshold.
    const r = planHedge(-200n, 600n, 0n, [short(1n, 400n), short(2n, 200n)], 5000n, CFG)
    expect(r.action).toBe('shrink')
    expect(r.burns).toEqual([2n]) // smallest-first, exact match, stop
    expect(r.mints).toEqual([])
  })

  it('Case E FLIP: sign reversal → burn all, open opposite side', () => {
    // H = -1000 (short), netDelta -1500 → H* = +500 (long)
    const r = planHedge(-1500n, 1000n, 0n, [short(1n, 1000n)], PORT, CFG)
    expect(r.action).toBe('flip')
    expect(r.burns).toEqual([1n])
    expect(r.mints).toEqual([{ tokenType: LONG, size: 500n }])
    expect(r.swapAtMint).toBe(true)
  })

  it('sign-flip trigger fires even when drift is tiny', () => {
    // H = -100 (short), netDelta -120 → H* = +20; drift 12bps < 200 but signFlip
    const r = planHedge(-120n, 100n, 0n, [short(1n, 100n)], PORT, CFG)
    expect(r.triggers.signFlip).toBe(true)
    expect(r.action).toBe('flip')
  })
})

describe('planHedge — mixed-side book (restart adoption)', () => {
  it('SHRINK burns only net-side hedges, never the off-side (no needless slippage)', () => {
    // Restart re-seeds every width=0 loan as a hedge, so the book can hold both
    // sides (e.g. a manually-minted long loan next to the bot's short). Naive
    // smallest-first would burn the LONG 100 first, moving H from -200 to -300
    // — AWAY from the -50 target. Correct: burn from the net (short) side only.
    // H = 100 - 300 = -200; netDelta = -150 → H* = -50; drift 300bps > 200.
    const r = planHedge(-150n, 300n, 100n, [short(1n, 300n), long(2n, 100n)], 5000n, CFG)
    expect(r.action).toBe('shrink')
    expect(r.burns).toEqual([1n]) // the off-side long (2n) is untouched
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 150n }])
    // Book after: long 100 + short 150 ⇒ H = -50 = H*.
    expect(r.swapAtMint).toBe(true)
  })

  it('over-cap mixed book rebuilds to |H*| state-changing (not the no-swap consolidate)', () => {
    const hedges = [
      short(1n, 100n),
      short(2n, 100n),
      short(3n, 100n),
      short(4n, 100n),
      long(5n, 50n),
    ]
    // H = 50 - 400 = -350; netDelta = -100 → H* = -250; drift 100bps < 200,
    // no sign flip, count 5 > cap 4. The state-preserving consolidate assumes a
    // single-sided book, so the mixed book is rebuilt with swapAtMint=true.
    const r = planHedge(-100n, 400n, 50n, hedges, PORT, CFG)
    expect(r.triggers).toEqual({ drift: false, overCap: true, signFlip: false })
    expect(r.action).toBe('consolidate')
    expect(r.burns).toEqual([1n, 2n, 3n, 4n, 5n])
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 250n }])
    expect(r.swapAtMint).toBe(true)
  })
})

describe('planHedge — capacity overlay', () => {
  it('pure capacity overlay (no drift/flip): consolidate to |H|, swapAtMint=false', () => {
    const hedges = [1n, 2n, 3n, 4n, 5n].map((id) => short(id, 100n))
    // 5 short hedges (H=-500), netDelta -150 (drift 150bps<200), H*=-350 (same side)
    const r = planHedge(-150n, 500n, 0n, hedges, PORT, CFG)
    expect(r.triggers).toEqual({ drift: false, overCap: true, signFlip: false })
    expect(r.action).toBe('consolidate')
    expect(r.burns).toEqual([1n, 2n, 3n, 4n, 5n])
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 500n }]) // |H|
    expect(r.swapAtMint).toBe(false)
  })

  it('GROW promotion: cap would be breached → consolidate to |H*| with swapAtMint=true', () => {
    const hedges = [1n, 2n, 3n, 4n].map((id) => short(id, 100n)) // count 4 == cap
    // H=-400, netDelta +1000 → H*=-1400 (GROW), +1 leg would breach cap
    const r = planHedge(1000n, 400n, 0n, hedges, PORT, CFG)
    expect(r.action).toBe('consolidate')
    expect(r.burns).toEqual([1n, 2n, 3n, 4n])
    expect(r.mints).toEqual([{ tokenType: SHORT, size: 1400n }]) // |H*|
    expect(r.swapAtMint).toBe(true)
  })
})
