# Hedger-bot deployment runbook

One-time, out-of-band setup of the on-chain infrastructure the bot drives. The
bot runtime never deploys anything — it only preflights and uses what this
runbook stands up.

## Architecture

```
Bot EOA ──execTransactionWithRole──▶ Zodiac Roles v2 ──(enabled module)──▶ Safe ──▶ PanopticPool.dispatch
                                       (scoped: loan-only)                  (holds options + hedge loans)

User EOA ──▶ Safe (owner)  — buys options, full control, everything else
```

- **Safe** — holds the option positions AND the hedge loans. Owner = user EOA (threshold 1).
- **Roles v2 modifier** — enabled as a module on the Safe; `owner`/`avatar`/`target` all = the Safe.
- **Bot EOA** — a role member scoped so it can ONLY call `PanopticPool.dispatch`
  with a `positionIdList` where every tokenId is a **pure width=0 loan**. It can
  never touch the user's option positions.

## The role scope (security boundary)

Target = the PanopticPool address. Selector = `dispatch(uint256[],uint256[],uint128[],int24[3][],bool,uint256)`.
Parameter condition (REQUIRED, not optional): `ArrayEvery` over arg 0
(`positionIdList`) → `Bitmask` asserting every tokenId's four 12-bit leg `width`
fields are zero. Arg 1 (`finalPositionIdList`) is intentionally unconstrained —
it legitimately contains the user's still-open option positions.

The exact width bitmask is computed and unit-tested in
`scripts/lib/loanTokenIdMask.ts` (`loanWidthFieldsMask`), verified against
real SDK-encoded loan vs option tokenIds. The Roles `ConditionFlat[]` tree is in
`scripts/lib/rolesScope.ts` (`buildLoanOnlyDispatchConditions`).

## Prerequisites

- Deployer/owner EOA (the user EOA) funded on the target chain.
- Bot EOA address (its key goes only in the bot `.env`).
- The PanopticPool address (options + hedge loans live here).
- Chain-specific Safe + Zodiac contract addresses (`SAFE_PROXY_FACTORY`,
  `SAFE_SINGLETON`, `ZODIAC_MODULE_PROXY_FACTORY`, `ROLES_MASTERCOPY`). These
  are built in for Ethereum mainnet (`scripts/lib/safeZodiacRegistry.ts`); supply
  them as env overrides only for other chains.
- A chosen `ROLE_KEY` (bytes32) and `SALT_NONCE` (`pnpm onboard` generates both).

## Quick start (recommended): `pnpm onboard`

For the common case — a fresh Safe on a supported chain (Ethereum mainnet) — the
interactive wizard replaces Steps 1–3 below:

```bash
pnpm onboard
```

It prompts for the essentials (RPC, pool, deployer key, bot key), auto-derives
the Safe/Zodiac addresses (from `scripts/lib/safeZodiacRegistry.ts`), the pool
metadata + `ASSET_INDEX`, and the Panoptic/Uniswap infrastructure; deploys +
scopes a fresh Safe & Roles modifier via the shared `scripts/lib/deployCore.ts`;
**verifies the loan-only boundary on-chain** (Step 0, automated via
`scripts/lib/verifyScope.ts`); and writes a complete `.env`. Nothing is written
until the scope verification passes. Run it against a fork first.

The manual, fully env-driven steps below remain the authoritative reference and
the path for unlisted chains or an externally-managed Safe.

## Steps

### 0. Dry-run on a fork FIRST

The deploy + scope scripts are ops tooling. Their shared deploy core
(`scripts/lib/deployCore.ts`) is covered by a mainnet fork test
(`scripts/setup.fork.test.ts`), and `pnpm onboard` re-runs the same assertion live
before writing `.env` — but for real deployments still run against an
anvil/Tenderly fork of the target chain and confirm the end state:

- module is enabled on the Safe; the modifier's avatar/target both = the Safe;
- bot EOA is a member of `ROLE_KEY`;
- bot **can** `dispatch` a pure width=0 loan;
- bot **cannot** `dispatch` a tokenId with any `width>0` leg (option) — the
  Roles `Bitmask` condition must revert it (`ConditionViolation`).

`pnpm onboard` and the fork test automate this via `scripts/lib/verifyScope.ts`
(loan passes the gate; option is blocked by a Roles `ConditionViolation`,
distinguished from a downstream PanopticPool revert). The `Bitmask` compValue
packing in `rolesScope.ts` is the single most important thing to confirm (some
modifier versions pack differently).

### 1. Deploy Safe + Roles + scope (programmatic)

```bash
# On Ethereum mainnet the Safe/Zodiac addresses are built in — omit them. For other
# chains add SAFE_PROXY_FACTORY / SAFE_SINGLETON / ZODIAC_MODULE_PROXY_FACTORY /
# ROLES_MASTERCOPY as overrides.
DEPLOYER_PRIVATE_KEY=0x... BOT_ADDRESS=0x... POOL_ADDRESS=0x... ROLE_KEY=0x... \
SALT_NONCE=1 RPC_URL=... CHAIN_ID=... \
pnpm deploy:safe-roles
```

It prints the `SAFE_ADDRESS` and `ROLES_MODIFIER_ADDRESS` to put in the bot `.env`.
The modifier is deployed owned by the deployer (so it can be scoped), then its
ownership is transferred to the Safe once scoping is complete.

Alternative (manual): deploy the Safe via the Safe UI and the Roles modifier via
the Zodiac app (app.safe.global), then run only the scoping step:

```
ROLES_OWNER_PRIVATE_KEY=0x... BOT_ADDRESS=0x... POOL_ADDRESS=0x... ROLE_KEY=0x... \
ROLES_MODIFIER_ADDRESS=0x... RPC_URL=... CHAIN_ID=... pnpm scope:bot-role
```

### 2. Fund + position the Safe

The user EOA buys the option positions into the Safe through the normal Panoptic
interface (the bot never does this) and deposits collateral.

### 3. Configure + start the bot

Fill `./.env` (see `.env.example`) with `SAFE_ADDRESS`,
`ROLES_MODIFIER_ADDRESS`, `ROLE_KEY`, `BOT_PRIVATE_KEY`, pool/chain/RPC, price
signal, and (optional) Telegram. Validate before going live:

```
pnpm inspect:hedge      # dry-run one cycle, prints the plan, sends nothing
DRY_RUN=true pnpm start  # full loop, simulates dispatch via eth_call
```

The bot's `init()` preflight verifies the Roles modifier is deployed and its
avatar/target both equal the Safe; a scope violation surfaces as a revert
(the executor requests `shouldRevert=true`).

## Cross-pool venue (EXPERIMENTAL — not covered by v1 support) — extra setup

When `HEDGE_VENUE=cross-pool-uniswap`, the bot hedges by atomically
withdrawing from the CollateralTracker, swapping asset↔numeraire on a DIFFERENT
Uniswap pool, and re-depositing — one Safe **MultiSend** batch routed through
Roles with `operation=DelegateCall`. The swap venue is a **whitelist** of pools
(`HEDGE_POOLS`, v3 and/or v4 on the same token pair); each cycle the bot
best-quotes across all of them (v4 V4Quoter / v3 QuoterV2) and swaps the winner.
Extra one-time setup:

1. **Roles scope** — re-run `scope:bot-role` with the cross-pool env set so it
   also: registers the MultiSend unwrapper (`setTransactionUnwrapper`), permits
   `delegatecall` to the MultiSend contract only, and scopes the inner targets.
   `HEDGE_POOLS` (same JSON as the bot config) drives the router template;
   `TOKEN0_ADDRESS`/`TOKEN1_ADDRESS` inject the fixed pair:
   ```
   MULTISEND_ADDRESS=0x... MULTISEND_UNWRAPPER_ADDRESS=0x... \
   UNIVERSAL_ROUTER_ADDRESS=0x... COLLATERAL0_ADDRESS=0x... COLLATERAL1_ADDRESS=0x... \
   TOKEN0_ADDRESS=0x... TOKEN1_ADDRESS=0x... \
   HEDGE_POOLS='[{"version":"v4","fee":500,"tickSpacing":10},{"version":"v3","fee":3000}]' \
   SAFE_ADDRESS=0x... ROLES_MODIFIER_ADDRESS=0x... POOL_ADDRESS=0x... ROLE_KEY=0x... \
   BOT_ADDRESS=0x... ROLES_OWNER_PRIVATE_KEY=0x... RPC_URL=... CHAIN_ID=... \
   pnpm scope:bot-role
   ```
   `CollateralTracker.withdraw`/`deposit` are parameter-scoped to `receiver`/`owner`
   == the Safe (prevents the bot pulling funds anywhere else). See the exact
   conditions in `scripts/lib/rolesScope.ts`.

2. **One-time token approvals (from the Safe)** — the UniversalRouter pulls the
   sell token from the Safe via Permit2. As the Safe owner (user EOA), grant:
   - `ERC20.approve(PERMIT2, max)` for both pool tokens,
   - `Permit2.approve(token, UNIVERSAL_ROUTER, max, expiry)` for both tokens, and
   - `ERC20.approve(<CollateralTracker>, max)` for both pool tokens, so the
     re-deposit leg (`CollateralTracker.deposit`) can pull the bought token back
     out of the Safe. Missing this makes every cross-pool cycle revert on deposit.
   These are one-time, done by the user EOA (not the bot).

3. **Router scope (calldata template, multi-pool).** The swap output can only
   reach the Safe in either version: v4's `TAKE_ALL` recipient is hardwired by
   v4-periphery to the `execute` caller, and v3's explicit recipient is pinned to
   the `MSG_SENDER` sentinel. So the risk is a DIFFERENT shape (explicit-recipient
   `TAKE`, `SWEEP`/`PERMIT2_TRANSFER_FROM` commands, or a swap on a non-whitelisted
   pool). `scope:bot-role` scopes `execute` with a template over `HEDGE_POOLS`:
   `commands` must equal one of the present versions' bytes (`0x10` v4 / `0x00`
   v3), and every `inputs` element must match one whitelisted pool template
   (structural bytes, recipient word, and pool identity — v4 PoolKey / v3 path —
   pinned via AND-ed Bitmask windows; only the amounts stay free). See
   `scripts/lib/routerScope.ts`.

   ⚠️  **Mixed v3+v4 cross-product.** commands and inputs are checked
   independently, so the scope admits mismatched combos (v4 command + v3 input and
   vice versa). These are not exploitable — the recipient-equivalent word is pinned
   in every template — but must be fork-verified to revert. If `TOKEN0/TOKEN1_ADDRESS`
   + `HEDGE_POOLS` are omitted, the script falls back to selector-only with a loud
   warning — do NOT ship that to production. Fork-validate: every whitelisted pool
   swaps in both directions; a tampered command / action / recipient / non-whitelisted
   pool reverts; and each cross-product combo reverts.

CowSwap (feature 4) is deferred: its async settlement can't be part of an atomic
withdraw→swap→deposit batch and needs a separate pending-order executor.
