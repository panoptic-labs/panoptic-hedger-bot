# @panoptic-eng/hedger-bot

Autonomous delta-hedging bot for [Panoptic](https://panoptic.xyz) v2 pools. It
watches the net delta of the option positions held in a Gnosis Safe and, when the
delta drifts past a threshold, mints/burns **hedge loans** to bring the portfolio
back toward delta-neutral — all through a [Zodiac Roles v2](https://github.com/gnosisguild/zodiac-modifier-roles)
modifier scoped so the bot can *only* touch loans, never the user's options.

```text
Bot EOA ──execTransactionWithRole──▶ Zodiac Roles v2 ──(enabled module)──▶ Safe ──▶ PanopticPool.dispatch
                                       (scoped: loan-only)                  (holds options + hedge loans)

User EOA ──▶ Safe (owner)  — buys options, full control, everything else
```

The bot is **stateless** (it re-derives all hedge state from on-chain positions
on every startup), so it is safe to restart or kill at any time.

**Supported in v1:** loan-only hedging · in-pool venue · Ethereum mainnet ·
pool-tick or CEX price signal · a single Safe + pool per instance. Cross-pool
routing, the `uniswap-pool` signal, and the extra Zodiac keeper roles exist but
are **experimental** (labelled below and in `.env.advanced.example`) — their
setup, monitoring, and recovery paths are not as hardened as the core.

## Quick start: `pnpm onboard`

The turnkey path. `pnpm onboard` is an interactive wizard that prompts for only
the essentials (RPC, pool, deployer key, bot key), **auto-derives** everything
else, **deploys a fresh Safe + Roles modifier**, **verifies the loan-only
security boundary on-chain**, and writes a complete `.env`. You need Node.js
`>=20 <23`, pnpm (via Corepack), and an RPC URL.

```bash
# From the repo root
corepack enable
pnpm install

# (repo root)
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
- **Bot signer** — generate a fresh key or import one. Generation uses the OS
  CSPRNG (`randomBytes`), which is sufficient on its own; you can optionally fold
  in your own extra entropy (mixed via keccak256, so it can only add to the RNG).
  Then choose how to store it: a **passphrase-encrypted keystore** (recommended —
  no plaintext at rest) or plaintext in `.env`.
- Optional: rehedge threshold and `DRY_RUN`.
- **Telegram alerts** are optional and configured out-of-band (not in the
  wizard): create a bot via @BotFather, then set `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID` in `.env`. `pnpm preflight --telegram-test` verifies delivery.
- Optional: **vanity Safe address** — the Safe is a CREATE2 proxy whose address
  is fixed by the deploy salt, so the wizard can search salts locally (no chain
  writes) for an address starting with a hex prefix you choose. Each extra hex
  character makes the search ~16× slower; 3–5 characters is near-instant.
The wizard deploys a strictly **loan-only** bot (minimal privilege): its role can
only mint/burn pure loans against the Safe, never touch your option positions.

**Advanced / EXPERIMENTAL: extra keeper roles.** The SDK also defines à-la-carte
roles beyond loan-only — `deleverager` (burn-only close), `maintenance` (force-exercise /
settle / liquidate third-party accounts — high privilege), `roller`, and
`size-adjuster`. This bot's runtime does **not** exercise them, so `pnpm onboard`
does not scope them. If you run a separate keeper that uses these capabilities,
scope one onto an existing modifier with `pnpm manage-role` (below).

**Changing role membership later.** Setup transfers the Roles modifier's
ownership to the Safe, so role membership is changed by the **Safe owner**, not
the bot. Use `pnpm manage-role` — it routes `assignRoles` through the Safe:

```bash
ROLE=deleverager MEMBER=0x… ENABLED=true \
SAFE_ADDRESS=0x… ROLES_MODIFIER_ADDRESS=0x… ROLES_OWNER_PRIVATE_KEY=0x… \
RPC_URL=… CHAIN_ID=… pnpm manage-role
```

`ROLE` is a canonical name (`deleverager`/`maintenance`/`roller`/`size-adjuster`)
or a bytes32 role key (e.g. the bot's `ROLE_KEY` from `.env`); `ENABLED=false`
revokes. You can also do this from the Zodiac app on app.safe.global.

Nothing is written to `.env` until the Safe + Roles are deployed **and** the
loan-only scope is verified (bot can dispatch a width=0 loan, cannot dispatch a
width>0 option). Re-run with `pnpm onboard --force` to overwrite an existing
`.env` (deploys a new Safe).

> First run against an **anvil/Tenderly fork** to rehearse end-to-end with no
> real transactions.

### Then run the bot (two-stage go-live)

Live trading is deliberately gated: `pnpm start` **forces dry-run** until you
`pnpm activate`, so nobody goes live by flipping one env var.

```bash
pnpm preflight           # read-only checks: wiring, scope, keys, gas, signal (sends NOTHING)
pnpm inspect:hedge       # dry-run one cycle — computes the hedge plan, sends NOTHING
pnpm start               # full loop; runs in dry-run until activated
pnpm activate            # re-runs preflight, confirms, writes the activation marker
pnpm start               # now trades live (needs DRY_RUN unset)
pnpm status              # operator snapshot: running, mode, positions, delta, last poll/hedge
```

(`pnpm doctor` is an alias for `pnpm preflight`; invoke it as `pnpm run doctor`
because `doctor` is also a built-in pnpm command.)

### Manual path

Prefer to wire everything yourself, or targeting a chain the wizard doesn't
list? Copy `.env.example` to `.env` and fill it in (minimum for a dry run:
`CHAIN_ID, RPC_URL, POOL_ADDRESS, SAFE_ADDRESS, ROLES_MODIFIER_ADDRESS,
ROLE_KEY, BOT_PRIVATE_KEY`), deploying the Safe + Roles out-of-band first — see
[Deployment](#deployment-safe--roles) below.

### Development

```bash
pnpm dev         # watch mode: rebuilds the SDK + restarts the bot on change
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
| `SAFE_ADDRESS` | ✅ | Gnosis Safe (deployed out-of-band) |
| `ROLES_MODIFIER_ADDRESS` | ✅ | Zodiac Roles v2 modifier enabled on the Safe |
| `ROLE_KEY` | ✅ | bytes32 role key assigned to the bot EOA |
| `BOT_PRIVATE_KEY` | ✅¹ | Bot signer key (raw hex) — **the only runtime secret** |
| `BOT_KEYSTORE_PATH` | ✅¹ | …or a passphrase-encrypted v3 keystore instead of a raw key |
| `BOT_KEYSTORE_PASSPHRASE` | | Keystore passphrase for unattended restart (else prompted at start) |
| `ASSET_INDEX` | | Which token is the sizing asset: `0` or `1` |
| `DELTA_THRESHOLD_BPS` | | Rehedge trigger, default `200` (2%) |
| `MAX_HEDGE_SLOTS` | | Consolidate hedge loans above this count, default `4` |
| `SLIPPAGE_BPS` | | Hedge swap slippage tolerance, default `30` |
| `PRICE_SIGNAL_SOURCE` | | `pool-tick` \| `cex` (v1); `uniswap-pool` (experimental) |
| `HEDGE_VENUE` | | `in-pool` (v1) \| `cross-pool-uniswap` (experimental spot rebalance) |
| `POLL_INTERVAL_MS` | | Loop interval, default `60000` |
| `DRY_RUN` | | `true` simulates via `eth_call`; live also requires `pnpm activate` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | Optional alerting (set both to enable) |

¹ Provide **exactly one** bot key source: `BOT_PRIVATE_KEY` (raw hex, plaintext
at rest) **or** `BOT_KEYSTORE_PATH` (a geth-style passphrase-encrypted keystore,
decrypted at startup — no plaintext at rest). `pnpm onboard` can generate the
keystore for you. If a keystore is used and `BOT_KEYSTORE_PASSPHRASE` is unset,
the bot prompts for the passphrase on startup (so unattended restart requires
setting it).

The CEX signal variables (`CEX_*`) are core. The **experimental**
`uniswap-pool` signal and `cross-pool-uniswap` venue variables
(`UNISWAP_SIGNAL_*`, `HEDGE_POOLS`, `UNIVERSAL_ROUTER_ADDRESS`,
`PERMIT2_ADDRESS`, `MULTISEND_ADDRESS`) live in `.env.advanced.example` — see
[`runbook.md`](./runbook.md).

## Deployment: Safe + Roles

`pnpm onboard` (above) is the recommended way to stand up the Safe + Roles — it
deploys a fresh Safe and scopes the bot. The commands below are the
non-interactive, fully env-driven equivalents. The bot runtime never deploys
anything — it only preflights and uses on-chain infrastructure you stand up once,
out-of-band. [`runbook.md`](./runbook.md) is the authoritative guide; the short
version:

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

The deploy flow creates the Roles modifier owned by the deployer, scopes it, then
transfers its ownership to the Safe — so no standing EOA-only admin remains.

> ⚠️ The deploy/scope scripts are ops tooling. `deploy:safe-roles` and the
> `pnpm onboard` wizard share the same deploy core, which is covered by a mainnet
> **fork test** (`scripts/setup.fork.test.ts`) asserting the end state (module
> enabled, avatar/target = Safe, bot can dispatch a width=0 loan, bot **cannot**
> dispatch anything with `width>0`). `pnpm onboard` re-runs that assertion live
> before writing `.env`. Still run against a fork first for real deployments.
> See runbook Step 0.

**Experimental:** for the `cross-pool-uniswap` venue there is additional Roles
scoping and one-time token approvals — see
[runbook.md § Cross-pool venue](./runbook.md). Not covered by v1 support.

## Running in Production

The bot ships with a multi-stage `Dockerfile` and a `docker-compose.yml`
(`restart: unless-stopped`, log rotation). It is self-contained —
`@panoptic-eng/sdk` is pulled from npm — so build straight from this directory:

```bash
# Compose (reads ./.env; rebuilds the image)
docker compose up -d --build

# Or plain docker
docker build -t hedger-bot .
docker run --env-file .env hedger-bot
```


Operational notes:

- **Stateless / idempotent** — one bot instance per Safe+pool; on restart it
  reconciles hedge state from on-chain positions. Safe to kill and relaunch.
- **Logging** is to stdout; **alerting** is optional Telegram. There is no
  metrics endpoint or health/liveness probe yet — add those in your orchestrator
  if you need them.
- **RPC** is a single endpoint with retry/backoff but no failover; front it with
  a resilient RPC gateway for production.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm onboard` | Interactive wizard: deploy Safe + Roles, verify scope, write `.env` |
| `pnpm preflight` | Read-only preflight checks (alias: `pnpm run doctor`); sends nothing |
| `pnpm start` | Run the hedging loop; dry-run until activated (`tsx src/main.ts`) |
| `pnpm activate` | Re-run preflight, confirm, and write the live-trading activation marker |
| `pnpm status` | Operator snapshot: running, mode, positions, delta, last poll/hedge |
| `pnpm inspect:hedge` | Dry-run one cycle, print the plan, send nothing |
| `pnpm deploy:safe-roles` | Deploy Safe + Roles modifier and scope the bot |
| `pnpm scope:bot-role` | (Re)scope the bot EOA on an existing modifier |
| `pnpm manage-role` | Add/remove a role member on an existing Safe (routed via the Safe owner) |
| `pnpm dev` / `typecheck` / `lint` / `test` | Development helpers |

## Project Structure

```text
./
├── src/
│   ├── main.ts          # Entrypoint: init + polling loop
│   ├── config.ts        # Env config schema + Zod validation
│   ├── hedgerBot.ts     # Orchestrator (per-cycle logic)
│   ├── hedge/           # Delta decision, reconciliation, safety gates
│   ├── priceSignal/     # Price sources: pool-tick, uniswap-pool, cex
│   ├── executor/        # Hedge execution (in-pool loans, cross-pool swaps)
│   ├── safe/            # Zodiac Roles executor
│   ├── notify/          # Telegram notifications
│   ├── presenters/      # Cycle summary formatting
│   ├── constants/ · utils/
├── scripts/             # setup (wizard), deploySafeAndRoles, scopeBotRole, inspectHedge
│   └── lib/             # deployCore, verifyScope, safeZodiacRegistry, renderEnv, prompts, rolesScope

├── docs/                # Technical notes
├── runbook.md           # Deployment & operations runbook
├── Dockerfile · docker-compose.yml
└── .env.example         # Annotated configuration template
```

## Documentation

| Document | Description |
|----------|-------------|
| [runbook.md](./runbook.md) | Full deployment & ops guide: architecture, role scope, fork verification, cross-pool setup |
| [.env.example](./.env.example) | Annotated configuration reference |
| [EXECUTION_MODULES_PLAN.md](./EXECUTION_MODULES_PLAN.md) | Design for pluggable execution backends |
| [docs/SWAPATMINT_DISCREPANCY.md](./docs/SWAPATMINT_DISCREPANCY.md) | Note on swap encoding differences |

## License

MIT
