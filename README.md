# ⚡ Panoptic Hedger Bot

Autonomous delta-hedging bot for [Panoptic](https://panoptic.xyz) v2 pools. It
watches the net delta of the option positions held in a Gnosis Safe and, when the
delta drifts past a threshold, mints/burns **hedge loans** to bring the portfolio
back toward delta-neutral — all through a [Zodiac Roles v2](https://github.com/gnosisguild/zodiac-modifier-roles)
modifier scoped so the bot can *only* touch loans, never the user's options.

The bot is **stateless** — it re-derives all hedge state from on-chain positions
on every startup — so it is safe to restart or kill at any time.

## What it does

Every cycle the bot:

1. Reads a price signal (the pool tick, a CEX mid, or an external Uniswap pool).
2. Computes the net delta of the Safe's Panoptic positions.
3. If the delta has drifted past `DELTA_THRESHOLD_BPS`, plans a hedge: mint or
   burn the loan legs needed to return toward delta-neutral, consolidating
   fragmented hedge slots when they exceed `MAX_HEDGE_SLOTS`.
4. Submits that plan to `PanopticPool.dispatch` **through the Zodiac Roles
   modifier**, which permits loan-only actions and rejects anything else.

Live trading is gated behind an explicit activation step (see below), and the
loop refuses to send anything until then.

## Key features

**Supported and hardened:** loan-only hedging · in-pool execution venue ·
Ethereum mainnet · `pool-tick` or CEX price signal · a single Safe + pool per
instance · passphrase-encrypted keystore · Telegram monitoring via
[@panopticMonitorBot](https://t.me/panopticMonitorBot) · durable transaction
journal + single-writer lease.

**Experimental** (labelled below and in `.env.advanced.example`, not as hardened
as the core): the `uniswap-pool` price signal and the extra à-la-carte Zodiac
keeper roles (`deleverager`, `maintenance`, `roller`, `size-adjuster`).

## Requirements

- Node.js `>=20 <23`
- pnpm (via Corepack: `corepack enable`)
- An RPC URL for the target chain (HTTPS required for remote endpoints; plain
  HTTP is accepted only for a loopback development fork)

## Getting started

### Quick start: `pnpm onboard`

The turnkey path. `pnpm onboard` is an interactive wizard that prompts for only
the essentials (RPC, pool, deployer key, bot key), **auto-derives** everything
else, **deploys a fresh Safe + Roles modifier**, **verifies the loan-only
security boundary on-chain**, and writes a complete `.env`.

```bash
# From the repo root
corepack enable
pnpm install

pnpm onboard            # prompts, deploys Safe + Roles, verifies scope, writes .env
```

The wizard asks for:

- **Target chain** — pick from the supported list (Ethereum mainnet) or enter a
  chain id manually (then supply Safe/Zodiac addresses via env).
- **RPC_URL** — validated against the selected chain id.
- **POOL_ADDRESS** — the PanopticPool; token pair, decimals, collateral
  trackers, pool id, and a suggested `ASSET_INDEX` are read from it.
- **Safe setup** — choose how you get a scoped Safe:
  - **Deploy a new Safe** (recommended) — provide your own wallet address
    (Ledger / MetaMask / Rabby) as the **owner**; the **bot itself** deploys the
    Safe + Roles, pays the gas, then hands ownership to you via `swapOwner` and
    keeps only its loan-only role. If the bot key is ever compromised, the
    attacker can only mint/burn loans; the owner wallet can still burn positions,
    withdraw, and redeploy.
  - **Use an existing Safe you control** — for adding a new pool to an existing
    hedger, or bringing a clean self-generated Safe. Provide `SAFE_ADDRESS` (and
    an existing `ROLES_MODIFIER_ADDRESS` + `ROLE_KEY` when adding a pool; leave
    the modifier blank to have the bot deploy one). Because your Safe owner is a
    hardware/multisig wallet, the wizard **prints the exact enable/scope
    transactions** for you to execute in the Safe UI (app.safe.global), then
    polls on-chain until the loan-only boundary is live. Roles scoping is
    additive, so adding a pool never un-scopes the others.
- **Bot signer** — generate a fresh key, import one, or reuse an existing
  owner-only `bot-keystore.json` without entering the plaintext key or rewriting
  the file. Generation uses the OS CSPRNG (`randomBytes`), which is sufficient on
  its own; you can optionally fold in your own extra entropy (mixed via
  keccak256, so it can only add to the RNG). New or imported keys can be stored
  in a **passphrase-encrypted keystore** (recommended — no plaintext at rest) or
  plaintext in `.env`.
- Optional: rehedge threshold and `DRY_RUN`.
- Optional: **vanity Safe address** — the Safe is a CREATE2 proxy whose address
  is fixed by the deploy salt, so the wizard can search salts locally (no chain
  writes) for an address starting with a hex prefix you choose. Each extra hex
  character makes the search ~16× slower; 3–5 characters is near-instant.

**Telegram notifications** are optional and set up out of the wizard. The
recommended path is the standalone **[@panopticMonitorBot](https://t.me/panopticMonitorBot)**
(the read-only monitor in `apps/panoptic-monitor-bot`): open a chat with it and
send `/monitor <SAFE_ADDRESS>` to follow your hedger's Safe — you'll get alerts
on its confirmed on-chain activity, plus `/positions` and `/greeks` on demand. No
bot token or `.env` change is needed on the hedger side.

Nothing is written to `.env` until the Safe + Roles are deployed **and** the
loan-only scope is verified (bot can dispatch a width=0 loan, cannot dispatch a
width>0 option). Re-run with `pnpm onboard --force` to overwrite an existing
`.env` (deploys a new Safe).

> First run against an **anvil/Tenderly fork** to rehearse end-to-end with no
> real transactions.

### Run the bot (two-stage go-live)

Live trading is deliberately gated: `pnpm start` **forces dry-run** until you
`pnpm activate`, so nobody goes live by flipping one env var.

```bash
pnpm preflight           # read-only checks: wiring, scope, keys, gas, signal (sends NOTHING)
pnpm inspect:hedge       # dry-run one cycle — computes the hedge plan, sends NOTHING
pnpm start               # full loop; runs in dry-run until activated
pnpm activate            # re-runs preflight, confirms, writes the activation marker
pnpm start               # now trades live (needs DRY_RUN unset)
pnpm status              # operator snapshot: running, mode, positions, delta, last poll/hedge
pnpm health              # machine-readable readiness; non-zero unless healthy and ready
pnpm deactivate          # emergency local kill marker; restart cannot trade until re-activated
```

(`pnpm doctor` is an alias for `pnpm preflight`; invoke it as `pnpm run doctor`
because `doctor` is also a built-in pnpm command.)

### Manual path

Prefer to wire everything yourself, or targeting a chain the wizard doesn't
list? Copy `.env.example` to `.env` and fill it in (minimum for a dry run:
`CHAIN_ID, RPC_URL, POOL_ADDRESS, SAFE_ADDRESS, ROLES_MODIFIER_ADDRESS,
ROLE_KEY, BOT_PRIVATE_KEY`), deploying the Safe + Roles out of the wizard first —
see [Deployment](#deployment-safe--roles) below.

### Development

```bash
pnpm typecheck   # type-check with tsconfig.build.json
pnpm lint        # eslint (max-warnings=0)
pnpm lint:fix    # eslint --fix
pnpm test        # vitest unit tests
```

## Configuration

All configuration is via environment variables (validated with Zod at startup;
a missing or malformed required var stops the bot immediately). `pnpm onboard`
generates a complete `.env` for you; this table is the reference for the values
it writes (and for the manual path). The full annotated list lives in
[`.env.example`](./.env.example); the essentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `CHAIN_ID` | ✅ | Target chain id (e.g. `1` for mainnet) |
| `RPC_URL` | ✅ | RPC endpoint for reads, gas estimation, and dispatch |
| `POOL_ADDRESS` | ✅ | Panoptic pool holding the options + hedge loans |
| `SAFE_ADDRESS` | ✅ | Gnosis Safe (deployed via the wizard or `deploy:safe-roles`) |
| `ROLES_MODIFIER_ADDRESS` | ✅ | Zodiac Roles v2 modifier enabled on the Safe |
| `ROLE_KEY` | ✅ | bytes32 role key assigned to the bot EOA |
| `BOT_PRIVATE_KEY` | ✅¹ | Bot signer key (raw hex) — **the only runtime secret** |
| `BOT_KEYSTORE_PATH` | ✅¹ | …or a passphrase-encrypted v3 keystore instead of a raw key |
| `BOT_KEYSTORE_PASSPHRASE` | | Keystore passphrase for unattended restart (else prompted at start) |
| `BOT_KEYSTORE_PASSPHRASE_FILE` | | Preferred owner-only passphrase secret file; mutually exclusive with the environment value |
| `ASSET_INDEX` | | Which token is the sizing asset: `0` or `1` |
| `DELTA_THRESHOLD_BPS` | | Rehedge trigger, default `200` (2%) |
| `MAX_HEDGE_SLOTS` | | Consolidate hedge loans above this count, default `4` |
| `SLIPPAGE_BPS` | | Hedge swap slippage tolerance, default `100` (±100 ticks for in-pool loans) |
| `PRICE_SIGNAL_SOURCE` | | `pool-tick` \| `cex` (supported); `uniswap-pool` (experimental) |
| `HEDGE_VENUE` | | `in-pool` (the only supported execution venue) |
| `POLL_INTERVAL_MS` | | Loop interval, default `60000` |
| `DRY_RUN` | | `true` simulates via `eth_call`; live also requires `pnpm activate` |
| `UNISWAP_LP_OWNER` | | Extra address (besides the Safe) holding plain Uniswap v3/v4 LP positions on this pool's pair; scanned alongside the Safe — see [Hedging Uniswap LP positions](#hedging-uniswap-lp-positions). |
| `HEDGE_INCLUDE_LP` | | `true` folds same-pair Uniswap LP delta into the hedge (only while the LP subgraph is fresh); default `false` = observe-only. |
| `LP_SUBGRAPH_URL` | | LP-positions subgraph (defaults to the mainnet deployment). |
| `LP_SUBGRAPH_MAX_LAG_BLOCKS` | | Max blocks the LP subgraph may lag chain head before LP delta is ignored, default `50`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | Legacy built-in alerting (set both to enable). Prefer [@panopticMonitorBot](https://t.me/panopticMonitorBot) instead — see Getting started. |

¹ Provide **exactly one** bot key source: `BOT_PRIVATE_KEY` (raw hex, plaintext
at rest) **or** `BOT_KEYSTORE_PATH` (a geth-style passphrase-encrypted keystore,
decrypted at startup — no plaintext at rest). `pnpm onboard` can generate the
keystore for you. If a keystore is used and neither non-interactive passphrase
source is set, the bot prompts at startup.

The CEX signal variables (`CEX_*`) are core. The experimental `uniswap-pool`
signal variables (`UNISWAP_SIGNAL_*`) live in `.env.advanced.example`.

## Hedging Uniswap LP positions

If you also run plain Uniswap v3/v4 LP positions on the **same token pair** as
this Panoptic pool, that concentrated-liquidity delta is real directional
exposure. The hedger can fold it into the delta it neutralizes each cycle, so it
hedges the combined Panoptic + LP book.

**Which positions:** every LP position on the Panoptic pool's exact token pair
(any fee tier, v3 or v4) owned by the **Safe** and — if set — the extra
`UNISWAP_LP_OWNER` address. Positions on other pairs are ignored (they can't be
neutralized by an in-pool hedge). Each is priced at the pool's current tick via
the SDK's concentrated-liquidity delta (`getLpGreeks`).

**Data source:** LP positions are read from the Panoptic LP subgraph
(`LP_SUBGRAPH_URL`) — one GraphQL query per owner per cycle, no extra RPC. The
same data powers [@panopticMonitorBot](https://t.me/panopticMonitorBot)'s
`/greeks` (send `/monitor <address>` there to eyeball Δ/Γ/value first).

**Two safety gates (both must pass for LP delta to be applied):**

1. **`HEDGE_INCLUDE_LP` (default `false`).** While off, the LP delta is computed
   and logged (`lpDelta … observed, not applied`) but **not** added to `netDelta`
   — hedge behaviour is identical to not tracking LPs. Verify the reported
   `lpDelta` with `pnpm inspect:hedge` before turning it on.
2. **Subgraph freshness.** Each cycle the bot compares the LP subgraph's indexed
   head to chain head; if it lags by more than `LP_SUBGRAPH_MAX_LAG_BLOCKS`
   (default `50`) — e.g. while it is still backfilling — LP delta is forced to
   observe-only with a warning, so a stale index can't cause an over-hedge.

Enable it only once the LP subgraph is fully synced **and** you've confirmed the
`lpDelta` line in `pnpm inspect:hedge` matches your real LP exposure.

## 🔒 Security model

Two trust boundaries meet at the Safe. The bot's hot key is scoped to loans; the
owner keeps everything else.

```text
    ┌──────────────┐   execTransactionWithRole   ┌───────────────────┐
    │   Bot EOA    │ ──────────────────────────▶ │  Zodiac Roles v2  │
    │  (hot key)   │      scoped: loan-only      │      modifier     │
    └──────────────┘                             └─────────┬─────────┘
                                                           │ enabled module
                                                           ▼
    ┌──────────────┐                             ┌───────────────────┐   dispatch   ┌───────────────┐
    │   User EOA   │ ──────── owner ───────────▶ │    Gnosis Safe    │ ───────────▶ │  PanopticPool │
    │ (hardware /  │  buy options · burn ·       │  holds options +  │              └───────────────┘
    │   multisig)  │  withdraw · full control    │    hedge loans    │
    └──────────────┘                             └───────────────────┘

    ── loan-only path (bot can ONLY mint/burn hedge loans, never touch options)
    ── owner path     (user keeps full control: options, withdrawals, redeploy)
```

The deploy flow creates the Roles modifier owned by the deployer, scopes it, then
transfers its ownership to the Safe — so no standing EOA-only admin remains, and
role membership is thereafter changed by the **Safe**, not the bot host.

### How the Zodiac module works

The scope the bot deploys is defined in the SDK, not here: see
[`panoptic-sdk/src/zodiac`](https://github.com/panoptic-labs/panoptic-sdk/tree/main/src/zodiac)
(the loan-only policy lives in
[`roles/loanHedger.ts`](https://github.com/panoptic-labs/panoptic-sdk/blob/main/src/zodiac/roles/loanHedger.ts)).

The [Zodiac Roles Modifier v2](https://github.com/gnosisguild/zodiac-modifier-roles)
is a contract **enabled as a module on the Safe**. Once enabled, a module can ask
the Safe to execute arbitrary transactions — so the whole security story is: the
bot is *not* a Safe owner and *cannot* call the Safe directly; it can only ask the
Roles modifier, and the modifier only relays calls that match a **scope** attached
to the bot's role.

**1. The bot's only entry point.** The bot signs exactly one kind of transaction —
a call to the modifier's `execTransactionWithRole`:

```solidity
execTransactionWithRole(
  address to,          // must be the PanopticPool (target is scoped)
  uint256 value,       // 0
  bytes   data,        // abi.encodeWithSelector(dispatch.selector, ...)
  uint8   operation,   // 0 = CALL (DelegateCall is not permitted)
  bytes32 roleKey,     // the bot's ROLE_KEY
  bool    shouldRevert // bot always passes true, so a scope failure reverts loudly
)
```

The modifier looks up `roleKey`, checks `data` against that role's scope for
`(to, selector)`, and — only if every condition passes — calls the Safe's
`execTransactionFromModule`, which performs the actual `PanopticPool.dispatch`.
If anything fails the scope, the whole thing reverts and nothing reaches the Safe.

**2. What "loan-only" actually constrains.** `dispatch` takes six arguments:

```solidity
dispatch(
  uint256[]   positionIdList,       // arg0: the tokenIds actually minted/burned  ← CONSTRAINED
  uint256[]   finalPositionIdList,  // arg1: the account's resulting position set ← free
  uint128[]   positionSizes,        // arg2                                        ← free
  int24[3][]  tickAndSpreadLimits,  // arg3                                        ← free
  bool        usePremiaAsCollateral,// arg4                                        ← free
  uint32      builderCode           // arg5                                        ← free
)
```

The scope pins only **arg0**: *every* element of `positionIdList` must be a **pure
loan** — a Panoptic tokenId whose four per-leg `width` fields are all zero. A
`width == 0` leg is a loan/credit leg; any `width > 0` leg is an actual option.
So the bot can mint and burn loan legs but can never open or close an option.
`finalPositionIdList` is deliberately left unconstrained because it legitimately
lists the user's still-open options.

**3. How the width check is encoded.** A Panoptic tokenId packs four 48-bit legs
above a 64-bit pool id; each leg's 12-bit `width` sits at leg-offset 36
([`tokenIdMask.ts`](https://github.com/panoptic-labs/panoptic-sdk/blob/main/src/zodiac/tokenIdMask.ts)).
"All widths zero" is the bitmask:

```
tokenId & 0x…  (1-bits over all four width fields)  ==  0
```

Roles v2 expresses this with `Operator.Bitmask` conditions. One wrinkle: the four
width fields span tokenId bits 100–255, wider than a single 15-byte Bitmask
window, so the scope AND-s **two** windows (byte shifts `0` and `17`) that together
cover all four legs. The scope is a flat `ConditionFlat[]` tree (BFS order) built
by [`buildLoanOnlyDispatchConditions()`](https://github.com/panoptic-labs/panoptic-sdk/blob/main/src/zodiac/roles/loanHedger.ts)
in `@panoptic-eng/sdk/zodiac`:

```
Calldata(dispatch)                       // root
├─ arg0 positionIdList   ArrayEvery      // for EVERY element…
│   └─ element (tokenId) And
│       ├─ Bitmask window @shift 0   → widths in legs 1,2,3 == 0
│       └─ Bitmask window @shift 17  → width in leg 0       == 0
├─ arg1 finalPositionIdList  Pass        // unconstrained
├─ arg2 positionSizes        Pass
├─ arg3 tickAndSpreadLimits  Pass
├─ arg4 usePremiaAsCollateral Pass
└─ arg5 builderCode          Pass
```

**4. Worked example.** Say the bot wants to burn one loan leg and mint a larger
one to re-hedge. It builds `positionIdList = [oldLoanId, newLoanId]` where both
ids have `width = 0` on every leg, encodes `dispatch(...)`, wraps it in
`execTransactionWithRole(pool, 0, data, 0, ROLE_KEY, true)`, and signs. The
modifier walks arg0, confirms `oldLoanId & widthMask == 0` and
`newLoanId & widthMask == 0`, and relays it. If a stolen key instead tried to
sneak a `width = 5` option leg into `positionIdList`, the `Bitmask` condition on
that element is non-zero → the modifier reverts → the Safe never sees the call.

> Verify, don't trust the prose: the fork test `scripts/setup.fork.test.ts`
> asserts the live modifier **can** dispatch a width-0 loan and **cannot**
> dispatch anything with `width > 0`, and `pnpm onboard` re-runs that check
> before writing `.env`.

**5. Cross-pool hedges (MultiSend).** When a hedge needs collateral moved between
pools, the bot batches `[CT.withdraw, router.execute, CT.deposit]` through Safe
**MultiSend**, with a MultiSend unwrapper registered on the modifier so each inner
call is re-checked individually. Those inner scopes are tighter still — e.g.
`CT.withdraw` is pinned to `receiver == owner == Safe` so a compromised key cannot
pull collateral to an attacker address
([`buildWithdrawConditions` / `buildDepositConditions`](https://github.com/panoptic-labs/panoptic-sdk/blob/main/src/zodiac/roles/loanHedger.ts)
in the SDK).

> ⚠️ The wizard deploys a **width-zero loan-only** bot. It cannot dispatch
> width-positive options, but the current role does **not** enforce loan size,
> tick, spread, premia-collateral, or builder-code bounds. A stolen bot key can
> therefore cause severe economic loss, including collateral exhaustion or
> liquidation. Treat this profile as **unsuitable for live funds** until
> loan-shape/size/tick bounds are enforced by the role. Experimental swap
> executors are not part of the supported runtime.

### Emergency deleverager (optional)

By default, when the account is liquidatable the bot **skips and alerts** — it
cannot de-risk on its own. Enabling the deleverager lets the bot actively
force-close positions when the account is liquidatable or its **margin buffer** —
the SDK liquidation distance `(currentMargin − requiredMargin) / requiredMargin`,
account-level and cross-collateral — falls below a trigger:

1. **Stage 1** closes options first — through a second, **burn-only** role key
   held by the same bot EOA. Options are the risk/margin driver, so closing them
   is what actually de-risks. Candidates are ranked by the **simulated health
   impact of closing the option *and* rehedging the freed delta** (biggest-|delta|
   first — closing a large-delta option unwinds the most hedge loans), and the
   freed delta is **re-hedged in the same cycle** via the loan role so the
   now-oversized loans shrink immediately. Burning the loans first would instead
   strip the hedge and leave the book *more* exposed.
2. **Fallback:** if there are no options left to close and the account is still
   at risk, the bot burns its own hedge loans (loan role) to relieve margin.

This works **even while the pool is paused**: a paused (safe-mode) Panoptic pool
is burn/close-only, so the emergency force-close still lands. Only a rehedge that
would *mint* a loan is deferred while paused; loan-shrinking burns proceed.

The deleverager role can **only burn** (every `positionSizes` entry must be 0 —
a zero size can never mint, and the whole dispatch reverts otherwise). It
**cannot mint, cannot move funds, and cannot settle premium**. Funds always stay
in the Safe. It is disabled by default; enable it with `DELEVERAGER_ENABLED=true`.

Provision it:

- **New deployment:** `pnpm onboard` asks whether to provision it (default no).
- **Existing deployment:** scope it onto your modifier and enable it in `.env`:
  ```bash
  ROLE=deleverager MEMBER=<bot-eoa> ACTION=provision \
  POOL_ADDRESS=0x… SAFE_ADDRESS=0x… ROLES_MODIFIER_ADDRESS=0x… \
  CHAIN_ID=1 pnpm manage-role > deleverager-proposal.json
  # import into the Safe UI, execute, then set DELEVERAGER_ENABLED=true and re-run `pnpm activate`
  ```

Tunables (schema defaults): `DELEVERAGE_TRIGGER_MARGIN_BPS=500` (act below a 5%
margin buffer — far below the `MIN_MARGIN_RESERVE_BPS` mint gate),
`DELEVERAGE_TARGET_MARGIN_BPS=1500` (hysteresis clear line),
`DELEVERAGE_SLIPPAGE_BPS=300` (wider burn band for ITM), `DELEVERAGE_COOLDOWN_MS=300000`.
`doctor`/`activate` verify the burn-only boundary on-chain when it is enabled.

> **Threat model note:** enabling the deleverager widens the bot key's blast
> radius from "mint/burn loans" to "burn any position." A compromised key could
> grief you by force-closing positions, but funds remain in the Safe (the role
> cannot withdraw or mint). Disable it (`DELEVERAGER_ENABLED=false`, and
> optionally revoke on-chain) if that trade-off isn't worth it for you.

### Other extra keeper roles (experimental)

The SDK also defines à-la-carte roles beyond loan-only and the deleverager —
`maintenance` (force-exercise / settle / liquidate third-party accounts — high
privilege), `roller`, and `size-adjuster`. This bot's runtime does **not**
exercise them, so `pnpm onboard` does not scope them and `pnpm manage-role
ACTION=provision` deliberately refuses them (only the reviewed burn-only
`deleverager` may be provisioned). If you run a separate keeper that uses these
capabilities, scope it out-of-band with your own tooling. Any extra role/member
beyond the reviewed {loan} or {loan + deleverager} manifest makes the modifier
differ from the exact production manifest, so `doctor` warns about the
experimental permission graph. Re-onboard with a fresh modifier to restore the
exact manifest.

### Changing role membership later

Because the Roles modifier's ownership is transferred to the Safe, role
membership is changed by the **Safe**, not the bot host. `pnpm manage-role` emits
unsigned Safe Transaction Builder JSON:

```bash
ROLE=deleverager MEMBER=0x… ACTION=assign \
SAFE_ADDRESS=0x… ROLES_MODIFIER_ADDRESS=0x… \
CHAIN_ID=… pnpm manage-role > role-proposal.json
```

`ROLE` is a canonical name (`deleverager`/`maintenance`/`roller`/`size-adjuster`)
or a bytes32 role key (e.g. the bot's `ROLE_KEY` from `.env`). `ACTION` selects
`assign` (default — add the member), `revoke` (remove the member), or `provision`
(the full assign + scopeTarget + scopeFunction batch for a named role on
`POOL_ADDRESS` — the existing-deployment path for the deleverager). No Safe-owner
key variable is accepted. Import the JSON into the Safe
UI, inspect/simulate the batch, and collect the Safe's configured threshold
approvals.

## Deployment: Safe + Roles

`pnpm onboard` (above) is the recommended way to stand up the Safe + Roles — it
deploys a fresh Safe and scopes the bot. The commands below are the
non-interactive, fully env-driven equivalents. The bot runtime never deploys
anything — it only preflights and uses on-chain infrastructure you stand up once.
[`runbook.md`](./runbook.md) is the authoritative guide; the short version:

```bash
# Deploy Safe + Roles modifier and scope the bot EOA (loan-only dispatch).
# On Ethereum mainnet the Safe/Zodiac addresses come from the built-in registry
# (scripts/lib/safeZodiacRegistry.ts) — omit them. For other chains, supply
# SAFE_PROXY_FACTORY / SAFE_SINGLETON / ZODIAC_MODULE_PROXY_FACTORY /
# ROLES_MASTERCOPY as env overrides.
DEPLOYER_PRIVATE_KEY=0x... BOT_ADDRESS=0x... POOL_ADDRESS=0x... ROLE_KEY=0x... \
SALT_NONCE=1 RPC_URL=... CHAIN_ID=... \
pnpm deploy:safe-roles

# Or, if the Safe + modifier already exist, just (re)scope the bot role
pnpm scope:bot-role
```

> ⚠️ The deploy/scope scripts are ops tooling. `deploy:safe-roles` and the
> `pnpm onboard` wizard share the same deploy core, which is covered by a mainnet
> **fork test** (`scripts/setup.fork.test.ts`) asserting the end state (module
> enabled, avatar/target = Safe, bot can dispatch a width=0 loan, bot **cannot**
> dispatch anything with `width>0`). `pnpm onboard` re-runs that assertion live
> before writing `.env`. Still run against a fork first for real deployments.
> See runbook Step 0.

## Running in production

The bot ships with a multi-stage `Dockerfile` and a `docker-compose.yml`
(`restart: unless-stopped`, log rotation). It is self-contained —
`@panoptic-eng/sdk` is pulled from npm — so build straight from this directory:

```bash
# Put the encrypted keystore and passphrase in the Compose secret files named
# by docker-compose.yml; .env must not also define BOT_PRIVATE_KEY.
# File-backed Compose secrets are bind mounts: both host files must be owned by
# uid 1000 (the container's node user) and have mode 0600 before startup.
docker compose up -d --build
```

Set `SOURCE_SHA` to the exact reviewed 40-character commit before building; the
image embeds it in `HEDGER_BUILD_ID`, and activation is invalidated when that
artifact identity changes.

Operational notes:

- **Durable and fenced** — mount `/var/lib/hedger` persistently. The transaction
  journal recovers replacement hashes and sender/nonce provenance across
  restarts, and the instance lease blocks two writers for the same Safe+pool.
- **Read-only container** — the root filesystem is read-only; state is confined
  to `/var/lib/hedger`, key material to `/run/secrets`, and `/tmp` is a small
  no-exec tmpfs. The image runs bundled JavaScript as the unprivileged `node` user.
- **Health** — the image healthcheck runs the signer-free compiled health command.
  Readiness fails on stale heartbeat, lifecycle failure, or repeated signal or
  notification failures.
- **RPC** is a single endpoint with retry/backoff but no failover; front it with
  a resilient RPC gateway for production.

### Operating a running container

The container runs the bot (`pnpm start`) as its single long-lived process — the
terminal that launched it only shows the logs. To read logs or run the
operator commands (`status`, `health`, `doctor`) you don't attach to that
process; you ask Docker to run a **new** one-shot command *inside the same
container* with `docker compose exec` (the service is named `hedger-bot`). Any
terminal on the Docker host can do this while the container is up:

```bash
docker compose logs -f hedger-bot          # follow the live bot output
docker compose exec hedger-bot pnpm status # operator snapshot (runs inside, then exits)
docker compose exec hedger-bot pnpm health # machine-readable readiness (exit code)
docker compose exec hedger-bot pnpm run doctor  # read-only preflight
```

These run against the **same** `.env`, RPC view, and `/var/lib/hedger` state
volume as the live bot, so they report a consistent picture — the reason to use
`exec` rather than running `pnpm status` on the host (which has neither the state
volume nor the keystore). They are read-only and touch only `/tmp`, so the
read-only root filesystem is not a problem.

Notes:

- In non-interactive contexts (cron, CI) add `-T` to disable the TTY:
  `docker compose exec -T hedger-bot pnpm health`.
- Inside the monorepo, point at the compose file from the repo root:
  `docker compose -f ./docker-compose.yml exec hedger-bot pnpm status`.
- Plain-Docker equivalent (no Compose): `docker ps` to find the container name,
  then `docker exec -it <name> pnpm status`.

## Troubleshooting

| Symptom | First check |
|---------|-------------|
| Something looks mis-wired (scope, keys, gas, signal) | `pnpm run doctor` — read-only, sends nothing and prints what fails |
| Bot won't trade even after `pnpm start` | It stays in dry-run until `pnpm activate`; run activate (which re-preflights) and unset `DRY_RUN` |
| Not sure what the bot is doing | `pnpm status` for a live snapshot; `pnpm health` for machine-readable readiness |
| Need to stop trading immediately | `pnpm deactivate` writes a local kill marker; a restart cannot trade until you re-activate |
| Startup fails on RPC | Remote RPC endpoints must be HTTPS; plain HTTP is only accepted for a loopback fork |
| Keystore start hangs / prompts | Set `BOT_KEYSTORE_PASSPHRASE_FILE` (owner-only) for unattended restart |
| Activation "invalidated" after a rebuild | `HEDGER_BUILD_ID` changed; set `SOURCE_SHA` to the reviewed commit and re-activate |
| `doctor` warns about the permission graph | Extra keeper roles/members were scoped; re-onboard with a fresh modifier to restore the exact manifest |
| No Telegram notifications | Message [@panopticMonitorBot](https://t.me/panopticMonitorBot) `/monitor <SAFE_ADDRESS>`, then `/status` to confirm it's following the Safe |

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm onboard` | Interactive wizard: deploy Safe + Roles, verify scope, write `.env` |
| `pnpm onboard:cleanup` | Report resume artifacts; remove only with explicit `--confirm` |
| `pnpm preflight` | Read-only preflight checks (alias: `pnpm run doctor`); sends nothing |
| `pnpm start` | Run the hedging loop; dry-run until activated (`tsx src/main.ts`) |
| `pnpm activate` | Re-run preflight, confirm, and write the live-trading activation marker |
| `pnpm deactivate` | Write the emergency local deactivation marker (sends nothing) |
| `pnpm health` | Signer-free machine-readable liveness/readiness check |
| `pnpm status` | Operator snapshot: running, mode, positions, delta, last poll/hedge |
| `pnpm inspect:hedge` | Dry-run one cycle, print the plan, send nothing |
| `pnpm deploy:safe-roles` | Deploy Safe + Roles modifier and scope the bot |
| `pnpm scope:bot-role` | (Re)scope the bot EOA on an existing modifier |
| `pnpm manage-role` | Add/remove a role member on an existing Safe (routed via the Safe owner) |
| `typecheck` / `lint` / `test` | Development helpers |

## Project structure

```text
./
├── src/
│   ├── main.ts          # Entrypoint: init + polling loop
│   ├── config.ts        # Env config schema + Zod validation
│   ├── hedgerBot.ts     # Orchestrator (per-cycle logic)
│   ├── hedge/           # Delta decision, reconciliation, safety gates
│   ├── priceSignal/     # Price sources: pool-tick, uniswap-pool, cex
│   ├── executor/        # In-pool loan execution
│   ├── safe/            # Zodiac Roles executor
│   ├── notify/          # Telegram notifications
│   ├── presenters/      # Cycle summary formatting
│   ├── constants/ · utils/
├── scripts/             # setup (wizard), deploySafeAndRoles, scopeBotRole, inspectHedge
│   └── lib/             # deployCore, verifyScope, safeZodiacRegistry, renderEnv, prompts, rolesScope
│
├── runbook.md           # Deployment & operations runbook
├── Dockerfile · docker-compose.yml
└── .env.example         # Annotated configuration template
```

## Documentation

| Document | Description |
|----------|-------------|
| [runbook.md](./runbook.md) | Full deployment & ops guide: architecture, role scope, and fork verification |
| [.env.example](./.env.example) | Annotated configuration reference |

## License

MIT
