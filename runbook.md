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

### Upgrade an existing Safe with the SFPM off-venue swap

Do not manually assemble a partial SFPM scope. From an existing hedger-bot
configuration, generate the complete owner-authorized batch:

```bash
pnpm deactivate
pnpm migrate:sfpm-venue > sfpm-venue-migration.json
```

This command sends nothing and never requests a Safe-owner key. It resolves the
reviewed venue from the deployment registry and emits one Safe Transaction
Builder batch containing:

- the canonical CompatibilityFallbackHandler when the Safe has no handler;
- the Roles MultiSend unwrapper;
- the pool-ID-pinned SFPM `multicall` scope;
- both collateral trackers' solvency-aware withdraw and Safe-bound deposit
  scopes;
- WETH deposit/withdraw scopes for native-ETH collateral; and
- every SFPM/collateral-tracker ERC-20 approval.

Import the JSON into Safe Transaction Builder, review and simulate every call,
collect the Safe's normal threshold approvals, and execute it. After
confirmation, copy the exact `.env` block printed by the command, then run:

```bash
pnpm run doctor
DRY_RUN=true pnpm inspect:hedge
pnpm activate
```

The batch is idempotent and works both for a Safe with no prior SFPM setup and
for an older partial setup. It preserves a compatible custom fallback handler;
an incompatible nonzero handler is a blocking error that requires owner review.
Fresh `pnpm onboard` configurations already include these on-chain
prerequisites and do not need the migration.

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

**Optional — Uniswap LP positions (same token pair).** If the Safe (or a
separate wallet) also holds plain Uniswap v3/v4 LP on this pool's pair, the bot
can fold that LP delta into the hedge:

- Set `UNISWAP_LP_OWNER` to the extra wallet holding LP — leave it unset if only
  the Safe holds LP (it is always scanned; pointing it at the Safe is harmless
  but redundant).
- Start with `HEDGE_INCLUDE_LP=false` (observe-only): the delta is computed and
  logged but not applied.
- Run `pnpm inspect:hedge` and verify the `lpDelta` line — position count,
  delta magnitude, and that the subgraph is fresh (not stale). `pnpm status` and
  `pnpm preflight` also surface the LP count, subgraph lag, and freshness.
- Once verified and the LP subgraph is fully synced, set `HEDGE_INCLUDE_LP=true`
  and re-run the sequence below. A runtime freshness guard
  (`LP_SUBGRAPH_MAX_LAG_BLOCKS`) still forces observe-only whenever the subgraph
  lags chain head, so a stale indexer can never cause a mis-hedge.

Guided activation performs the ordered preflight, read-only hedge inspection,
SFPM route choice, safety review, and live confirmation for the exact candidate
artifact. Repeat it after any configuration, role, Safe, pool, signer, or
build-identity change:

```
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

## Multi-instance host operations

The supported template at
[`examples/multi-instance`](./examples/multi-instance/) runs three independent
hedgers from one reviewed image. The default `docker-compose.yml` remains the
single-instance path. The reusable files contain no credentials and do not
create a private operations directory for you.

### Prepare and validate the operations checkout

From the standalone hedger source directory, copy the template outside the
checkout and create the generic instance directories:

```bash
cp -R examples/multi-instance ../hedger-ops
cd ../hedger-ops
cp .env.example .env
for instance in instance-a instance-b instance-c; do
  mkdir "$instance"
  cp instance.env.example "$instance/hedger.env"
done
```

For each instance, fill `hedger.env`, place `bot-keystore.json` and
`bot-keystore-passphrase` beside it, then set both secret files to mode `0600`.
Every instance needs its own signer, Safe/pool assignment, state volume, and
staged-secret volume. Config files must not contain `BOT_PRIVATE_KEY`,
`BOT_KEYSTORE_PASSPHRASE`, or overrides for the Compose-owned runtime/key paths.

Build the reviewed source exactly once, tag it with the complete commit, record
the same SHA for Compose, and run the offline validation before startup:

```bash
SOURCE_REPO=../panoptic-hedger-bot
SOURCE_SHA=$(git -C "$SOURCE_REPO" rev-parse HEAD)
git -C "$SOURCE_REPO" archive "$SOURCE_SHA" | \
  docker build \
    --build-arg SOURCE_SHA="$SOURCE_SHA" \
    --tag "panoptic-hedger-bot:$SOURCE_SHA" \
    -
printf 'SOURCE_SHA=%s\n' "$SOURCE_SHA" > .env
pnpm --dir ../panoptic-hedger-bot multi:check -- "$PWD"
docker compose up -d
```

The checker makes no network calls and never decrypts a keystore. It discovers
directories containing `hedger.env`, applies the full runtime configuration
schema, verifies secret presence/ownership/mode, reads only the encrypted
keystore's public address, and rejects duplicate signers or duplicate
chain+Safe+pool identities. Successful output is limited to instance names,
public identities, the image SHA, and dry/live mode.

In a monorepo checkout, build from the repository root instead:

```bash
SOURCE_REPO=../panoptic-monorepo-ui
SOURCE_SHA=$(git -C "$SOURCE_REPO" rev-parse HEAD)
git -C "$SOURCE_REPO" archive "$SOURCE_SHA" | \
  docker build \
    --build-arg SOURCE_SHA="$SOURCE_SHA" \
    --tag "panoptic-hedger-bot:$SOURCE_SHA" \
    --file ./Dockerfile \
    -
```

### Bring one instance live

`DRY_RUN=false` is intentional in each `hedger.env`: the absent activation
marker in a fresh state volume remains the authoritative gate and forces the
main process to simulate. Do not activate all services together. For each
instance, observe dry-run, validate, activate, restart, and health-check in this
order:

```bash
SERVICE=instance-a
docker compose logs -f "$SERVICE" # observe a complete dry-run cycle; then Ctrl-C
docker compose exec "$SERVICE" node dist/scripts/status.js
docker compose exec "$SERVICE" node dist/scripts/doctor.js
docker compose exec "$SERVICE" node dist/scripts/inspectHedge.js
docker compose exec "$SERVICE" node dist/scripts/activate.js --read-only-config
docker compose restart "$SERVICE"
docker compose exec "$SERVICE" node dist/scripts/health.js
docker compose exec "$SERVICE" node dist/scripts/status.js
```

Container activation uses the configured `SFPM_SWAP_ENABLED` value, refuses
`DRY_RUN=true`, writes only the activation marker in `/var/lib/hedger`, and never
edits `hedger.env`. The service restart is required because the long-running
main process evaluates activation at startup. Host-side `pnpm activate` remains
interactive and retains its existing `.env` update behavior.

The normal per-instance commands are:

```bash
SERVICE=instance-a
docker compose logs -f "$SERVICE"
docker compose exec "$SERVICE" node dist/scripts/status.js
docker compose exec "$SERVICE" node dist/scripts/doctor.js
docker compose exec "$SERVICE" node dist/scripts/inspectHedge.js
docker compose exec "$SERVICE" node dist/scripts/activate.js --read-only-config
docker compose exec "$SERVICE" node dist/scripts/deactivate.js
docker compose exec "$SERVICE" node dist/scripts/health.js
docker compose start "$SERVICE"
docker compose stop "$SERVICE"
docker compose restart "$SERVICE"
```

Deactivation installs the immediate send kill switch and removes activation.
Restart after any later successful activation so the main process re-evaluates
the marker. Use `-T` on non-interactive `exec` calls; activation itself needs an
interactive terminal for review and confirmation.

### Isolation and upstream capacity

There must be at most one active strategy for a given chain+Safe+pool, and no
two active instances may share a signer. The lease lives in one state volume;
separate volumes cannot fence duplicate deployments and duplicate signers can
race the same nonce.

Capacity-plan the combined load. Three hedgers multiply RPC reads and event
subscriptions, CEX WebSockets, LP-subgraph queries, and Telegram messages.
Confirm provider quotas and rate limits, use resilient RPC gateways (including
configured fallbacks), and give each Telegram destination enough alert capacity
to avoid masking an unhealthy instance.

### Rolling upgrades

Build and tag the new reviewed SHA before changing `.env`. Then change the
single `SOURCE_SHA`, replace only one hedger, and repeat the full validation and
activation sequence before continuing:

```bash
SOURCE_REPO=../panoptic-hedger-bot
NEW_SHA=$(git -C "$SOURCE_REPO" rev-parse HEAD)
git -C "$SOURCE_REPO" archive "$NEW_SHA" | \
  docker build --build-arg SOURCE_SHA="$NEW_SHA" \
    --tag "panoptic-hedger-bot:$NEW_SHA" -
printf 'SOURCE_SHA=%s\n' "$NEW_SHA" > .env
pnpm --dir ../panoptic-hedger-bot multi:check -- "$PWD"

docker compose up -d --no-deps instance-a
# doctor → inspect → activate --read-only-config → restart → health
# Continue with instance-b, then instance-c, only after the prior service is healthy.
```

A changed `HEDGER_BUILD_ID` invalidates the old activation marker by design.
The template intentionally has one shared `${SOURCE_SHA}`. A brief rolling
transition may leave old containers running their prior image, but permanently
divergent versions require distinct image variables or separate deployments.

### State backup and restore

State includes activation, the transaction journal, cadence checkpoints, and
runtime safety markers. Stop the affected instance before backup so the archive
is transactionally quiet:

```bash
SERVICE=instance-a
VOLUME=panoptic-hedgers_instance-a-state
IMAGE="panoptic-hedger-bot:$(sed -n 's/^SOURCE_SHA=//p' .env)"
mkdir -p backups
docker compose stop "$SERVICE"
docker run --rm --user 0:0 --entrypoint /bin/sh \
  --volume "$VOLUME:/state:ro" --volume "$PWD/backups:/backup" \
  "$IMAGE" -c 'tar czf /backup/instance-a-state.tgz -C /state .'
docker compose start "$SERVICE"
```

Before restore, verify no container on any host is running a copy of the same
chain+Safe+pool or signer. A restore into a live or duplicated instance can
replay stale operational assumptions. Replace the stopped service's volume,
restore the archive, then start and verify it:

```bash
docker compose stop instance-a
docker compose rm -f instance-a
docker volume rm panoptic-hedgers_instance-a-state
docker volume create panoptic-hedgers_instance-a-state
docker run --rm --user 0:0 --entrypoint /bin/sh \
  --volume panoptic-hedgers_instance-a-state:/state \
  --volume "$PWD/backups:/backup:ro" "$IMAGE" \
  -c 'tar xzf /backup/instance-a-state.tgz -C /state && chown -R 1000:1000 /state'
docker compose up -d --no-deps instance-a
docker compose exec instance-a node dist/scripts/status.js
docker compose exec instance-a node dist/scripts/health.js
```

Never restore while another copy is active. Preserve backups with the same care
as other operational records; although private keys are staged in a separate
volume, state reveals public strategy identities and transaction history.

### Secret rotation and teardown

Deactivate and stop one service, update its Safe role if the signer changes,
replace the two host secret files with owner-only files, validate, restage, and
reactivate:

```bash
docker compose exec instance-a node dist/scripts/deactivate.js
docker compose stop instance-a
# Replace instance-a/bot-keystore.json and bot-keystore-passphrase; chmod 0600 both.
pnpm --dir ../panoptic-hedger-bot multi:check -- "$PWD"
docker compose run --rm instance-a-secret-init
docker compose up -d --no-deps instance-a
# doctor → inspect → activate --read-only-config → restart → health
```

Ordinary `docker compose down` preserves all named volumes. **Never use
`docker compose down --volumes` as a routine stop command:** it destroys
activation markers, journals, checkpoints, and staged secrets for every
instance.

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
