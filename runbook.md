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
the Zodiac app, then generate an unsigned, inspectable scoping proposal:

```
BOT_ADDRESS=0x... POOL_ADDRESS=0x... ROLE_KEY=0x... SAFE_ADDRESS=0x... \
ROLES_MODIFIER_ADDRESS=0x... CHAIN_ID=... pnpm scope:bot-role > scope-proposal.json
```

Import the JSON into Safe Transaction Builder, review and simulate every call,
then collect the Safe's normal threshold approvals. Never place a Safe-owner key
on the bot host.

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

The production sequence is deliberately ordered and must be repeated for the
exact candidate artifact after any configuration, role, Safe, pool, signer, or
build-identity change:

```
pnpm preflight
pnpm inspect:hedge
DRY_RUN=true pnpm start
pnpm activate
pnpm start
pnpm status
pnpm health
# emergency stop, then restart the process:
pnpm deactivate
```

`pnpm activate` fingerprints the verified authorization and runtime policy;
there is no force bypass. `pnpm deactivate` is a local kill switch, not an
on-chain revocation. For compromised-key response, the Safe owners must revoke
the role member through the normal Safe threshold and rotate the key.

The bot's `init()` preflight verifies the Roles modifier is deployed and its
avatar/target both equal the Safe; a scope violation surfaces as a revert
(the executor requests `shouldRevert=true`).

Cross-pool and asynchronous swap executors are intentionally outside the v1
runtime. Their earlier prototypes were removed so the shipped configuration,
recovery journal, and Roles proposal describe one execution model: in-pool,
loan-only dispatch.

## Emergency deleverager (optional)

When `DELEVERAGER_ENABLED=true`, the bot force-closes positions instead of only
alerting once the account is liquidatable or its **margin buffer** — the SDK
liquidation distance `(currentMargin − requiredMargin) / requiredMargin`,
account-level and cross-collateral — drops below `DELEVERAGE_TRIGGER_MARGIN_BPS`.
It closes **options first** through the burn-only deleverager role, because
options are the risk/margin driver. Candidates are ranked by the **simulated
health impact of closing the option AND rehedging the freed delta** (largest
|delta| tried first, since closing a big-delta option unwinds the most hedge
loans); the freed delta is then **re-hedged in-cycle** via the loan role, so the
oversized loans shrink immediately rather than next poll. Only as a last resort
(no options left, still at risk) does it burn its own hedge loans outright.

This runs **even while the pool is paused**: a paused (safe-mode) Panoptic pool
is burn/close-only — mints revert but burns land — so deleveraging works exactly
when it's needed most. The only thing suppressed while paused is a rehedge that
would *mint* a loan (a hedge *grow*); pure loan-shrinking burns still proceed.
Everything runs urgent and bypasses the basefee deferral gate — a liquidation
penalty dwarfs any gas spike.

**Provision on an existing deployment** (owner executes; the bot holds the role):

```bash
ROLE=deleverager MEMBER=<bot-eoa> ACTION=provision \
POOL_ADDRESS=0x… SAFE_ADDRESS=0x… ROLES_MODIFIER_ADDRESS=0x… \
CHAIN_ID=1 pnpm manage-role > deleverager-proposal.json
# execute in the Safe UI, then set DELEVERAGER_ENABLED=true in .env and re-run `pnpm activate`.
```

Enabling it bumps the activation policy version, so **existing activation markers
are invalidated** — you must re-run `pnpm activate` after turning it on.

**Alerts.** Telegram (never rate-limited) fires when the trigger is detected, on
each stage result (with the burned tokenIds and tx hash), and — critically — if
the account is STILL at risk after all stages (`🆘 CRITICAL … manual intervention
required`). Treat that CRITICAL alert as a page: inspect the Safe positions,
add collateral, or close positions manually.

**Verify what was burned.** `pnpm status` shows the deleverager line (last stage,
margin buffer, and whether an incident is active). The burned tokenIds are in the
Telegram/console stage summary and on-chain in the dispatch tx.

**Disable it.** Set `DELEVERAGER_ENABLED=false` and restart (the bot reverts to
skip-and-alert). To also remove the on-chain capability, revoke the member:
`ROLE=deleverager MEMBER=<bot-eoa> ACTION=revoke … pnpm manage-role`.
`pnpm deactivate` also halts deleveraging (it shares the send kill switch).

The deleverager role can **only burn** (every `positionSizes` entry must be 0):
it cannot mint, move funds, or settle premium. `pnpm run doctor` fails (not
warns) if it is enabled but the burn-only scope is not live on-chain.
