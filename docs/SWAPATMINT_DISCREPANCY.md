# `swapAtMint` discrepancy note — RESOLVED (no code bug)

**Status:** resolved. The original claim below was based on a misreading of the
`dispatch` ABI. The shipped vault-managers code is correct; no code change was
required. This note is kept as the record of the investigation so the mistake
is not repeated by the hedger-bot executor implementer.

## The original claim (incorrect)

It was reported that the vault-managers incremental delta-hedge dispatch
(`apps/vault-managers/src/managers/delta_hedge/index.ts`, INCREMENTAL branch)
mints with `swapAtMint=false` — which, under the wallet-aware delta model,
would make every incremental hedge a zero-delta no-op (the borrowed asset
lands in the wallet and its `getLegDelta = −size` contribution is exactly
cancelled by the wallet increase in the collateral term).

The claim pointed at the `false` literal in the encoded `dispatch(...)` args.

## Why the claim is wrong

PanopticPool V2 `dispatch` has **no `swapAtMint` parameter**. Its signature is:

```
dispatch(
  TokenId[] positionIdList,
  TokenId[] finalPositionIdList,
  uint128[] positionSizes,
  int24[3][] tickAndSpreadLimits,
  bool usePremiaAsCollateral,   // ← the `false` literal the report flagged
  uint256 builderCode
)
```

See `packages/panoptic-v2-core/contracts/PanopticPool.sol` (`dispatch`, ~line
666) and the ABI vault-managers encodes against
(`packages/sdk/src/abis/panoptic_v2_abis.ts`, entry `name: 'dispatch'`,
input `usePremiaAsCollateral`).

**Swap-at-mint is signaled by tick-limit ordering, not a bool.** In the V2
SFPM (`packages/panoptic-v2-core/contracts/SemiFungiblePositionManagerV4.sol`):

- `invertedLimits = tickLimitLow > tickLimitHigh` (unlockCallback, ~line 564)
- the ITM swap (`swapInAMM`) only runs `if (invertedLimits)` (~lines 882–887)

The SDK write path implements exactly this mapping
(`packages/sdk/src/panoptic/v2/writes/position.ts`):
`swapAtMint=true` → descending `[high, low, spread]`;
`swapAtMint=false` → ascending `[low, high, spread]`.

## What the shipped vault-managers code actually does (correct)

`apps/vault-managers/src/managers/delta_hedge/index.ts`:

- **INCREMENTAL** (state-changing mint) passes
  `getInvertedTickLimit(currentTick, slippageBps)` =
  `[tick + slippageBps, tick − slippageBps, 0]` — **descending**, i.e.
  `swapAtMint = true`. ✓ matches the SDK `getDeltaHedgeParams` result and the
  efficient-hedging spec for all state-changing cases.
- **CONSOLIDATE** (state-preserving capacity overlay) passes
  `NORMAL_TICK_LIMIT = [-887272, 887272, 0]` — **ascending**, i.e.
  `swapAtMint = false`. ✓ matches the spec's requirement that the capacity
  reorganization not move delta.

So all three sources (SDK, spec, shipped code) agree; the apparent conflict
came from reading `usePremiaAsCollateral` as `swapAtMint`.

## Follow-up applied

- `EFFICIENT_HEDGING_ALGORITHM.md` §13's "critical correctness item" (which
  made the same ABI misreading) has been corrected.
- Clarifying comments were added next to the tick-limit constants and the
  `dispatch` encodings in `delta_hedge/index.ts`.
- `apps/hedger-bot/src/executor/types.ts` now documents that
  `HedgeIntent.swapAtMint` must be encoded as tick-limit ordering — the
  executor implementer must NOT pass it as the 5th `dispatch` bool.
