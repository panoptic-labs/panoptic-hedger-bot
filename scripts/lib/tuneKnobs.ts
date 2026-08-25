import { formatUnits } from 'viem'

import type { HedgerBotConfig } from '../../src/config'

/**
 * The strategy/gas/cadence knobs `pnpm tune` re-prompts. Everything here is a
 * pure `.env` value the runtime reads at startup — no knob changes the on-chain
 * permission surface. Strategy changes are activation-bound, so the operator
 * must inspect and reactivate before the next live start. Keys that
 * DO affect the safety boundary (DRY_RUN, SFPM_SWAP_ENABLED, the provisioning
 * flags) are deliberately excluded; those go through `pnpm onboard` / `pnpm
 * activate`.
 */
export interface TuneKnob {
  key: string
  /** One-line hint shown next to the prompt. */
  hint: string
  /** Current effective value (post-defaults), rendered as the prompt default. */
  current: (cfg: HedgerBotConfig) => string
  /** Skip the prompt entirely when the knob's feature is not in use. */
  applies?: (cfg: HedgerBotConfig) => boolean
  /** 'confirm' renders as a y/n prompt and stores 'true'/'false'. */
  kind?: 'text' | 'confirm'
}

const gwei = (value: bigint) => formatUnits(value, 9)

export const TUNE_KNOBS: readonly TuneKnob[] = [
  {
    key: 'DELTA_THRESHOLD_BPS',
    hint: 'rehedge trigger (drift bps)',
    current: (cfg) => cfg.DELTA_THRESHOLD_BPS.toString(),
  },
  {
    key: 'TIMED_HEDGE_INTERVAL_MS',
    hint: '0 disables; otherwise 300000–604800000 and >= poll interval',
    current: (cfg) => String(cfg.TIMED_HEDGE_INTERVAL_MS),
  },
  {
    key: 'TIMED_HEDGE_MIN_DRIFT_BPS',
    hint: 'inner timed band; must be below the hard threshold',
    current: (cfg) => cfg.TIMED_HEDGE_MIN_DRIFT_BPS.toString(),
  },
  {
    key: 'DELTA_OFFSET_BPS',
    hint: 'target delta bias, bps; 0 = neutral, +long / -short',
    current: (cfg) => cfg.DELTA_OFFSET_BPS.toString(),
  },
  {
    key: 'URGENT_DRIFT_MULTIPLIER',
    hint: 'drift >= multiplier x threshold loosens the gas gate',
    current: (cfg) => String(cfg.URGENT_DRIFT_MULTIPLIER),
  },
  {
    key: 'SLIPPAGE_BPS',
    hint: 'hedge dispatch tick band',
    current: (cfg) => String(cfg.SLIPPAGE_BPS),
  },
  {
    key: 'MIN_MARGIN_RESERVE_BPS',
    hint: 'free-collateral floor gating new mints',
    current: (cfg) => cfg.MIN_MARGIN_RESERVE_BPS.toString(),
  },
  {
    key: 'POLL_INTERVAL_MS',
    hint: 'hedge cycle cadence',
    current: (cfg) => String(cfg.POLL_INTERVAL_MS),
  },
  {
    key: 'HEDGE_INCLUDE_LP',
    hint: 'fold external Uniswap LP delta into the hedge',
    current: (cfg) => String(cfg.HEDGE_INCLUDE_LP),
    kind: 'confirm',
  },
  {
    key: 'HEDGE_MAX_BASE_FEE_GWEI',
    hint: 'routine hedges defer above this basefee',
    current: (cfg) => gwei(cfg.HEDGE_MAX_BASE_FEE_GWEI),
  },
  {
    key: 'URGENT_MAX_BASE_FEE_GWEI',
    hint: 'urgent hedges defer above this basefee (>= routine cap)',
    current: (cfg) => gwei(cfg.URGENT_MAX_BASE_FEE_GWEI),
  },
  {
    key: 'MAX_FEE_GWEI',
    hint: 'absolute per-tx fee cap (>= urgent basefee cap)',
    current: (cfg) => gwei(cfg.MAX_FEE_GWEI),
  },
  {
    key: 'MAX_PRIORITY_FEE_GWEI',
    hint: 'routine priority-tip ceiling',
    current: (cfg) => gwei(cfg.MAX_PRIORITY_FEE_GWEI),
  },
  {
    key: 'MIN_PRIORITY_FEE_GWEI',
    hint: 'priority-tip floor for every transaction',
    current: (cfg) => gwei(cfg.MIN_PRIORITY_FEE_GWEI),
  },
  {
    key: 'URGENT_PRIORITY_FEE_GWEI',
    hint: 'urgent priority-tip floor',
    current: (cfg) => gwei(cfg.URGENT_PRIORITY_FEE_GWEI),
  },
  {
    key: 'SFPM_SWAP_MIN_SAVINGS_BPS',
    hint: 'route off-venue only when 5bps beats in-pool by this margin',
    current: (cfg) => cfg.SFPM_SWAP_MIN_SAVINGS_BPS.toString(),
    applies: (cfg) => cfg.SFPM_SWAP_PROVISIONED,
  },
  {
    key: 'SFPM_SWAP_SLIPPAGE_BPS',
    hint: 'off-venue swap tick band (falls back to SLIPPAGE_BPS)',
    current: (cfg) => String(cfg.SFPM_SWAP_SLIPPAGE_BPS ?? cfg.SLIPPAGE_BPS),
    applies: (cfg) => cfg.SFPM_SWAP_PROVISIONED,
  },
  {
    key: 'DELEVERAGE_TRIGGER_MARGIN_BPS',
    hint: 'emergency deleverage trigger buffer',
    current: (cfg) => cfg.DELEVERAGE_TRIGGER_MARGIN_BPS.toString(),
    applies: (cfg) => cfg.DELEVERAGER_ENABLED,
  },
  {
    key: 'DELEVERAGE_TARGET_MARGIN_BPS',
    hint: 'deleverage burns until this buffer is restored',
    current: (cfg) => cfg.DELEVERAGE_TARGET_MARGIN_BPS.toString(),
    applies: (cfg) => cfg.DELEVERAGER_ENABLED,
  },
  {
    key: 'DELEVERAGE_SLIPPAGE_BPS',
    hint: 'emergency burn tick band (wider than SLIPPAGE_BPS on purpose)',
    current: (cfg) => String(cfg.DELEVERAGE_SLIPPAGE_BPS),
    applies: (cfg) => cfg.DELEVERAGER_ENABLED,
  },
  {
    key: 'DELEVERAGE_COOLDOWN_MS',
    hint: 'minimum spacing between deleverage rounds',
    current: (cfg) => String(cfg.DELEVERAGE_COOLDOWN_MS),
    applies: (cfg) => cfg.DELEVERAGER_ENABLED,
  },
]

/**
 * Keep only the answers that change the rendered `.env`: a value identical to
 * the key's existing line is a no-op, and a value identical to the schema
 * default for an unset key would only pin today's default — skip both so the
 * written diff is exactly what the operator changed.
 */
export function diffTuneAnswers(
  env: NodeJS.ProcessEnv,
  answers: Readonly<Record<string, string>>,
  currents: Readonly<Record<string, string>>,
): Record<string, string> {
  const updates: Record<string, string> = {}
  for (const [key, value] of Object.entries(answers)) {
    const existing = env[key]
    if (existing !== undefined ? value === existing : value === currents[key]) continue
    updates[key] = value
  }
  return updates
}

/** Parse a rendered .env body into a plain object for config validation. */
export function dotenvObject(body: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return out
}
