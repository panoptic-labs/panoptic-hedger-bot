# AGENTS.md — operating the Panoptic hedger bot

Guidance for AI coding/ops agents helping someone run this bot. Read this before
suggesting commands or edits. Keep humans in control of anything that moves funds.

The bot keeps a Gnosis Safe's option delta neutral by minting/burning **loan-only**
hedge positions on a Panoptic v2 pool, routed through a Zodiac Roles v2 modifier
that scopes the bot to *only* touch loans — never the user's options or funds.

## Golden path (the supported order)

```bash
pnpm install            # Node >=20 <23, pnpm via corepack
pnpm onboard            # interactive: deploy Safe + Roles, scope loan-only, write .env
pnpm run doctor         # read-only preflight (alias: pnpm preflight) — sends NOTHING
pnpm start              # runs the loop; DRY-RUN until activated (see below)
pnpm activate           # re-runs preflight, confirms, writes the live-trading marker
pnpm start              # now trades live (also needs DRY_RUN unset in .env)
pnpm status             # operator snapshot any time
```

## Hard rules (do not violate)

- **Going live is two-stage and deliberate.** `pnpm start` **forces dry-run**
  until `pnpm activate` has written a valid activation marker (`.hedger-activated.json`,
  pinned to this Safe/pool/chain). Live trading requires **both** `DRY_RUN=false`
  in `.env` **and** that marker. If a user says "it's not trading," do NOT just set
  `DRY_RUN=false` — check activation (`pnpm status` shows the mode and why). Never
  fabricate or hand-edit the marker; run `pnpm activate`.
- **`pnpm doctor` collides with pnpm's built-in command.** Always invoke it as
  `pnpm run doctor` or the `pnpm preflight` alias.
- **The bot EOA must never be a Safe owner.** It only holds a scoped role. Never
  suggest adding it as an owner or raising its privileges. The Safe owner (the
  user's hardware/multisig wallet) authorizes everything else.
- **Loan-only is the security boundary.** Never widen the Roles scope to allow
  option dispatch, withdrawals, or arbitrary calls. `pnpm run doctor` verifies the
  boundary (loan allowed, options blocked); treat a scope failure as blocking.
- **Diagnose, don't guess.** For "is it set up right / safe?" run `pnpm run doctor`.
  For "what is it doing right now?" run `pnpm status`. Prefer these over reading logs
  or on-chain state by hand — each check reports a concrete remedy.

## Never touch / never leak

- Do not read, print, paste, or commit: `.env`, `bot-keystore.json`,
  `*.keystore.json`, `deploy-state.json`, `.hedger-runtime.json`,
  `.hedger-activated.json`, or any private key / keystore passphrase. They are
  gitignored for a reason. `pnpm status` prints the bot **address**, never key
  material — follow that pattern.
- Prefer the **encrypted keystore** over a plaintext `BOT_PRIVATE_KEY`.

## v1 scope (what to recommend)

Supported and hardened: **loan-only hedging · in-pool venue · Ethereum mainnet ·
`pool-tick` or `cex` price signal · one Safe + one pool per instance.**

**Experimental — do NOT recommend for production** (setup/monitoring/recovery are
not as hardened; they live in `.env.advanced.example`): the `cross-pool-uniswap`
venue, the `uniswap-pool` price signal, and the extra Zodiac keeper roles
(`deleverager` / `maintenance` / `roller` / `size-adjuster`). The bot warns at
startup and in `doctor` when one is configured.

## Common situations

- **"Bot started but nothing happens / stays dry-run"** → `pnpm status`. If mode is
  dry-run, either `DRY_RUN=true` in `.env` or not activated → `pnpm activate`.
- **"preflight fails"** → each `✗` line has a remedy; fix that, re-run. Do not
  activate while any check fails (`pnpm activate` refuses).
- **"low gas / stuck tx"** → the bot pays its own gas; top up the printed bot
  address. Gas caps live in `.env` (`MAX_FEE_GWEI`, `HEDGE_MAX_BASE_FEE_GWEI`, …).
- **Telegram alerts** → optional, configured in `.env` (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`), not in the wizard. Verify with `pnpm preflight --telegram-test`.
- **Add a second pool / reuse an existing Safe** → `pnpm onboard` → "Use an existing
  Safe"; it prints the owner-authorized transactions to run in the Safe UI.

## Where things live

- `src/main.ts` — startup, activation gate, poll loop, heartbeat.
- `src/hedgerBot.ts` — one hedge cycle (signal → positions → safety → plan → execute).
- `src/config.ts` — env schema (source of truth for every setting + default).
- `src/runtime/` — activation marker + runtime heartbeat (drives `status`).
- `scripts/setup.ts` — the `onboard` wizard.
- `scripts/lib/diagnostics/` — the `doctor`/`status` checks.
- `README.md` / `runbook.md` — human docs; deeper detail than this file.

## Verifying changes

`pnpm typecheck && pnpm lint && pnpm test` before proposing a diff. Fork-level
checks need a local `anvil` fork. Never run `pnpm start` without `DRY_RUN=true`
(or an un-activated setup) unless the user explicitly wants live trading.
