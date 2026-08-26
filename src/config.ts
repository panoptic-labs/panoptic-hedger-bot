import { getChainDeployment } from '@panoptic-eng/sdk/v2'
import { DELEVERAGER_ROLE_KEY as SDK_DELEVERAGER_ROLE_KEY } from '@panoptic-eng/sdk/zodiac'
import { getAddress, isAddress, isHex, parseEther, parseUnits, size } from 'viem'
import { z } from 'zod'

/**
 * Environment / configuration schema for the hedger bot.
 *
 * The bot keeps a Gnosis Safe's net option delta neutral by minting/burning
 * width=0 hedge loans on a Panoptic pool, routing every write through a Zodiac
 * Roles modifier as the (narrowly-scoped) bot EOA. The Safe + Roles modifier are
 * deployed and scoped out-of-band (see runbook.md); this config only points at
 * the already-deployed addresses.
 */

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address')
  .superRefine((value, ctx) => {
    if (!isAddress(value, { strict: true })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mixed-case address checksum is invalid',
      })
    }
  })
  .transform((value) => getAddress(value))

const bytes32Schema = z
  .string()
  .refine(
    (value): value is `0x${string}` => isHex(value) && size(value) === 32,
    'must be a 32-byte hex value',
  )

const privateKeySchema = z
  .string()
  .refine(
    (value): value is `0x${string}` => isHex(value) && size(value) === 32,
    'must be a 32-byte hex private key',
  )

const rpcUrlSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must use HTTPS (HTTP is allowed only for a loopback development RPC)',
      })
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not embed credentials in the URL',
      })
    }
  })

const booleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

function boundedInteger(min: number, max: number, defaultValue?: number) {
  const schema = z
    .string()
    .regex(/^(0|[1-9]\d*)$/, 'must be a plain non-negative integer')
    .transform(Number)
    .refine(Number.isSafeInteger, 'must be a safe integer')
    .refine((value) => value >= min && value <= max, `must be between ${min} and ${max}`)
  return defaultValue === undefined ? schema : schema.default(String(defaultValue))
}

function integerAtLeast(min: number, defaultValue?: number) {
  const schema = z
    .string()
    .regex(/^(0|[1-9]\d*)$/, 'must be a plain non-negative integer')
    .transform(Number)
    .refine(Number.isSafeInteger, 'must be a safe integer')
    .refine((value) => value >= min, `must be at least ${min}`)
  return defaultValue === undefined ? schema : schema.default(String(defaultValue))
}

function boundedBigint(min: bigint, max: bigint, defaultValue?: bigint) {
  const schema = z
    .string()
    .regex(/^(0|[1-9]\d*)$/, 'must be a plain non-negative integer')
    .transform(BigInt)
    .refine((value) => value >= min && value <= max, `must be between ${min} and ${max}`)
  return defaultValue === undefined ? schema : schema.default(defaultValue.toString())
}

// Signed variant of boundedBigint: accepts an optional leading minus sign so a
// directional bias (e.g. a target-delta offset) can be negative. boundedBigint's
// regex rejects '-', so this cannot reuse it.
function boundedSignedBigint(min: bigint, max: bigint, defaultValue: bigint) {
  return z
    .string()
    .regex(/^-?(0|[1-9]\d*)$/, 'must be a plain integer')
    .transform(BigInt)
    .refine((value) => value >= min && value <= max, `must be between ${min} and ${max}`)
    .default(defaultValue.toString())
}

function boundedAmount(
  parse: (value: string) => bigint,
  min: string,
  max: string,
  defaultValue: string,
) {
  const minimum = parse(min)
  const maximum = parse(max)
  return z
    .string()
    .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'must be a plain finite decimal')
    .transform((value, ctx) => {
      try {
        return parse(value)
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'has too many decimal places' })
        return z.NEVER
      }
    })
    .refine((value) => value >= minimum && value <= maximum, `must be between ${min} and ${max}`)
    .default(defaultValue)
}

const boundedGwei = (min: string, max: string, defaultValue: string) =>
  boundedAmount((value) => parseUnits(value, 9), min, max, defaultValue)
const boundedEth = (min: string, max: string, defaultValue: string) =>
  boundedAmount(parseEther, min, max, defaultValue)

// Default LP-positions subgraph (Ethereum mainnet) — the same deployment the
// monitor bot reads. Indexes plain Uniswap v3/v4 LP positions.
export const DEFAULT_LP_SUBGRAPH_URL =
  'https://api.goldsky.com/api/public/project_cl9gc21q105380hxuh8ks53k3/subgraphs/panoptic-subgraph-lp-mainnet/v2_prod/gn'

/** Default for LP_SUBGRAPH_MAX_LAG_BLOCKS; shared with the setup wizard's preview. */
export const DEFAULT_LP_SUBGRAPH_MAX_LAG_BLOCKS = 50n

export const PRICE_SIGNAL_SOURCES = ['pool-tick', 'uniswap-pool', 'cex'] as const

/**
 * Schema defaults for the emergency deleverager tunables. Single source of
 * truth so the `.env` renderer and docs never drift from the parser.
 */
export const DELEVERAGE_DEFAULTS = {
  TRIGGER_MARGIN_BPS: 500n,
  TARGET_MARGIN_BPS: 1_500n,
  SLIPPAGE_BPS: 300,
  COOLDOWN_MS: 300_000,
} as const
export type PriceSignalSourceKind = (typeof PRICE_SIGNAL_SOURCES)[number]

const rawEnvSchema = z
  .object({
    // Chain / RPC
    CHAIN_ID: z.coerce.number().int().positive(),
    RPC_URL: rpcUrlSchema,
    // Optional secondary endpoint: reads/sends fall back to it when the primary
    // errors (viem fallback transport, deterministic order — primary first).
    RPC_URL_FALLBACK: rpcUrlSchema.optional(),

    // Panoptic pool holding options + hedge loans
    POOL_ADDRESS: addressSchema,

    // Safe + Zodiac Roles (deployed out-of-band)
    SAFE_ADDRESS: addressSchema,
    ROLES_MODIFIER_ADDRESS: addressSchema,
    ROLE_KEY: bytes32Schema,

    // Bot signer — provide EXACTLY ONE of BOT_PRIVATE_KEY (raw hex) or
    // BOT_KEYSTORE_PATH (a passphrase-encrypted v3 keystore, decrypted at
    // startup). For a keystore, BOT_KEYSTORE_PASSPHRASE supplies the passphrase
    // non-interactively (unattended restart); if unset, it is prompted at start.
    BOT_PRIVATE_KEY: privateKeySchema.optional(),
    BOT_KEYSTORE_PATH: z.string().min(1).optional(),
    BOT_KEYSTORE_PASSPHRASE: z.string().optional(),
    BOT_KEYSTORE_PASSPHRASE_FILE: z.string().min(1).optional(),

    // Hedging parameters
    ASSET_INDEX: z.enum(['0', '1']).transform((v) => BigInt(v)),
    DELTA_THRESHOLD_BPS: boundedBigint(1n, 5_000n, 200n),
    // Optional hybrid cadence: the hard threshold always fires immediately;
    // once this interval is due, the smaller inner drift band may also fire.
    // Zero disables the timed trigger for backwards compatibility.
    TIMED_HEDGE_INTERVAL_MS: boundedInteger(0, 604_800_000, 0),
    TIMED_HEDGE_MIN_DRIFT_BPS: boundedBigint(0n, 5_000n, 100n),
    // Target net delta the bot hedges TOWARD, as signed bps of portfolio size
    // (0 = delta-neutral, positive = long bias, negative = short bias).
    DELTA_OFFSET_BPS: boundedSignedBigint(-5_000n, 5_000n, 0n),
    MAX_HEDGE_SLOTS: boundedInteger(1, 16, 4),
    // 100 bps maps conservatively to a ±100 tick execution band for in-pool loans.
    SLIPPAGE_BPS: boundedInteger(0, 500, 100),
    MIN_MARGIN_RESERVE_BPS: boundedBigint(500n, 9_000n, 2_000n),

    // Emergency deleverager (optional, opt-in; see README). When enabled the bot
    // EOA holds a second, burn-only role key on the same Roles modifier and
    // force-closes positions when the account is liquidatable or its margin
    // buffer (distance to liquidation) falls below the trigger — options first
    // (ranked by the simulated close+rehedge health impact), rehedging the freed
    // delta in-cycle. Runs even while the pool is paused (safe-mode is close-only).
    DELEVERAGER_ENABLED: booleanSchema.default('false'),
    // Defaults to the SDK's canonical deleverager role key; set only when the
    // modifier was scoped with a custom key.
    DELEVERAGER_ROLE_KEY: bytes32Schema.optional(),
    // Deleverage when the margin buffer — the SDK liquidation "distance"
    // (currentMargin − requiredMargin) / requiredMargin, cross-collateral,
    // account-level — drops below this (bps). Deliberately far below
    // MIN_MARGIN_RESERVE_BPS (which gates NEW mints) so routine hedging never
    // trips it.
    DELEVERAGE_TRIGGER_MARGIN_BPS: boundedBigint(
      50n,
      5_000n,
      DELEVERAGE_DEFAULTS.TRIGGER_MARGIN_BPS,
    ),
    // Hysteresis clear line: a deleverage incident ends (and burning stops) once
    // the margin buffer recovers to this (bps).
    DELEVERAGE_TARGET_MARGIN_BPS: boundedBigint(
      100n,
      9_000n,
      DELEVERAGE_DEFAULTS.TARGET_MARGIN_BPS,
    ),
    // Emergency burn tick band — wider than SLIPPAGE_BPS on purpose: ITM burns
    // swap in-pool, and a band revert here means staying at liquidation risk.
    DELEVERAGE_SLIPPAGE_BPS: boundedInteger(0, 1_000, DELEVERAGE_DEFAULTS.SLIPPAGE_BPS),
    // Per-stage re-fire throttle while an incident is open, so a burn whose
    // effect has not landed yet does not re-fire every poll.
    DELEVERAGE_COOLDOWN_MS: boundedInteger(60_000, 3_600_000, DELEVERAGE_DEFAULTS.COOLDOWN_MS),

    // Price signal source
    PRICE_SIGNAL_SOURCE: z.enum(PRICE_SIGNAL_SOURCES).default('pool-tick'),
    // uniswap-pool signal: another pool on the SAME token pair as the options pool.
    UNISWAP_SIGNAL_POOL_VERSION: z.enum(['v3', 'v4']).default('v3'),
    UNISWAP_SIGNAL_POOL_ADDRESS: addressSchema.optional(), // v3 pool contract
    UNISWAP_SIGNAL_STATE_VIEW_ADDRESS: addressSchema.optional(), // v4 StateView
    UNISWAP_SIGNAL_POOL_ID: bytes32Schema.optional(), // v4 poolId
    // cex signal: multi-exchange aggregated ETH price. The aggregator feeds are
    // hardcoded to ETH/USD(T), so this defaults to ETH-USD and only needs setting
    // to assert intent (validated against the ETH/USD(T) pattern in priceSignal).
    CEX_SYMBOL: z.string().min(1).default('ETH-USD'),
    CEX_STALE_MS: boundedInteger(1_000, 60_000, 12_000),
    // Sanity guard: if the price-signal tick and the pool's on-chain tick differ
    // by more than this, the cycle is skipped (a huge gap means the signal is
    // misconfigured — wrong ASSET_INDEX inverts the price, wrong pool, etc. — and
    // dispatching would revert with PriceBoundFail). ~5000 ticks ≈ a 65% price gap.
    SIGNAL_TICK_SANITY_MAX: boundedInteger(100, 10_000, 5_000),
    MAX_SIGNAL_BLOCK_AGE_SECONDS: boundedInteger(15, 120, 36),
    CEX_MIN_FEEDS: boundedInteger(1, 3, 3),

    // Kept as an explicit literal so old in-pool deployments remain valid while
    // removed experimental venues fail instead of silently changing behavior.
    HEDGE_VENUE: z.literal('in-pool').default('in-pool'),

    // Gas policy (keeper EOA pays all gas — no Safe refund).
    // Hard EIP-1559 caps applied to every send:
    MAX_FEE_GWEI: boundedGwei('1', '1000', '400'),
    MAX_PRIORITY_FEE_GWEI: boundedGwei('0.01', '100', '2'),
    // Every send pays at least this priority tip, even when the RPC estimator
    // returns zero. Without a floor, fee bumps cannot raise a zero tip.
    MIN_PRIORITY_FEE_GWEI: boundedGwei('0.01', '100', '0.1'),
    // Urgent tip FLOOR: when a hedge is urgent (see URGENT_DRIFT_MULTIPLIER) the
    // priority tip is lifted to at least this, so an RPC estimating a near-zero
    // tip can't leave an urgent hedge unprioritised in a volatility spike. May
    // deliberately exceed MAX_PRIORITY_FEE_GWEI (the routine ceiling) — only
    // MAX_FEE_GWEI bounds it.
    URGENT_PRIORITY_FEE_GWEI: boundedGwei('0.01', '100', '1'),
    // Two-tier deferral: routine hedges wait out basefee spikes; urgent hedges
    // (drift >= URGENT_DRIFT_MULTIPLIER x DELTA_THRESHOLD_BPS) tolerate more.
    HEDGE_MAX_BASE_FEE_GWEI: boundedGwei('1', '500', '50'),
    URGENT_MAX_BASE_FEE_GWEI: boundedGwei('1', '1000', '300'),
    URGENT_DRIFT_MULTIPLIER: boundedInteger(1, 20, 3),
    // The keeper's target minimum ETH — shown in the low-gas alert as the level
    // to top back up to. NOT the alert trigger (see KEEPER_BALANCE_WARN_ETH).
    MIN_KEEPER_BALANCE_ETH: boundedEth('0.001', '100', '0.05'),
    // Only warn/alert once the keeper EOA's ETH actually falls below this — keeps
    // routine balances above the warn line from spamming the log every poll.
    KEEPER_BALANCE_WARN_ETH: boundedEth('0.001', '100', '0.015'),
    // Give up waiting for a dispatch receipt after this long (alert; the next
    // cycle re-reads chain state and reconciles).
    TX_RECEIPT_TIMEOUT_MS: boundedInteger(30_000, 900_000, 180_000),
    // While waiting, re-send the same nonce with >=12.5%-bumped fees every this
    // often, until MAX_FEE_GWEI caps the escalation or the receipt budget ends.
    TX_BUMP_INTERVAL_MS: boundedInteger(5_000, 300_000, 45_000),
    // Blocks past a pending intent's submission before recovery declares its
    // nonce slot a mempool-drop and auto-fails the entry. Below this, the
    // slot is treated as still-in-flight and the entry is retained.
    HEDGER_NONCE_STALL_BLOCKS: boundedInteger(4, 4_096, 64),

    // Loop
    // Authoritative account reconciliation cadence. Price and account events
    // are monitored separately between these full snapshots.
    POLL_INTERVAL_MS: integerAtLeast(5_000, 300_000),
    // Permissionless direct-EOA recovery call. Opt-in because it spends keeper
    // gas independently of hedge dispatches; live use is activation-bound.
    ORACLE_POKE_ENABLED: booleanSchema.default('false'),
    DRY_RUN: booleanSchema.default('false'),
    BALANCE_FIRST_ENABLED: booleanSchema.default('false'),

    // Optional
    // Block floor for the SDK position-event scan (syncPositions). Defaults to
    // the chain's protocol genesis; override to a later block to speed the first
    // (full) scan on chains not in the built-in genesis map.
    SYNC_FROM_BLOCK: z
      .string()
      .regex(/^(0|[1-9]\d*)$/, 'must be a plain non-negative integer')
      .transform(BigInt)
      .optional(),
    PANOPTIC_BUILDER_CODE: z.string().optional(),
    // Optional extra address (besides the Safe) whose plain Uniswap v3/v4 LP
    // positions on this pool's token pair are folded into the hedge delta when
    // HEDGE_INCLUDE_LP is enabled. Also used for read-only monitoring via
    // @panopticMonitorBot (/monitor <address>).
    UNISWAP_LP_OWNER: addressSchema.optional(),
    // Uniswap LP delta hedging (see README "Tracking Uniswap LP positions").
    // LP positions are read from the LP subgraph; delta is only ADDED to the
    // hedge when HEDGE_INCLUDE_LP=true AND the subgraph is fresh (see guard).
    LP_SUBGRAPH_URL: z.string().url().default(DEFAULT_LP_SUBGRAPH_URL),
    HEDGE_INCLUDE_LP: booleanSchema.default('false'),
    // Max blocks the LP subgraph head may lag chain head before LP delta is
    // treated as unavailable (observe-only). Guards against a still-syncing
    // subgraph causing a mis-hedge.
    LP_SUBGRAPH_MAX_LAG_BLOCKS: boundedBigint(0n, 10_000_000n, DEFAULT_LP_SUBGRAPH_MAX_LAG_BLOCKS),
    // Telegram notifications (both required together to enable).
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),

    // ---------------------------------------------------------------------
    // Off-venue SFPM swap (v3 only). Routes the hedge-netting swap through a
    // cheaper Uniswap v3 pool (e.g. 5bps) via SFPM.multicall([mint,burn]),
    // aggregated with CT withdraw/deposit through a Safe MultiSend. See the
    // SDK panoptic/v2/sfpmSwap module + zodiac SfpmSwapCondition.
    // NOTE: distinct from the removed cross-pool-uniswap path — new env names.
    // ---------------------------------------------------------------------
    // True only after onboarding/migration has installed the reviewed Roles
    // scopes and token approvals. Enabling execution without provisioning is
    // rejected below.
    SFPM_SWAP_PROVISIONED: booleanSchema.default('false'),
    SFPM_SWAP_ENABLED: booleanSchema.default('false'),
    // Off-venue execution is intentionally v3-only. A v4 PoolManager custody
    // design needs a separate reviewed accounting/authorization model.
    SFPM_SWAP_POOL_VERSION: z.literal('v3').default('v3'),
    SFPM_SWAP_ADDRESS_V3: addressSchema.optional(),
    // The cheaper Uniswap v3 pool to swap in. Its ERC20 pair (e.g. USDC/WETH)
    // corresponds to the options pool's collateral assets, bridging native ETH
    // via WETH when the options pool's currency0 is native.
    SFPM_SWAP_POOL_ADDRESS: addressSchema.optional(),
    // Uniswap fee tier of SFPM_SWAP_POOL_ADDRESS (e.g. 500 = 0.05%).
    SFPM_SWAP_FEE: boundedInteger(1, 1_000_000, 500),
    // Optional pinned uint64 SFPM poolId; resolved on-chain at startup when unset.
    SFPM_SWAP_POOL_ID: z.coerce.bigint().optional(),
    // Slippage band (bps) for the SFPM swap; falls back to SLIPPAGE_BPS when unset.
    SFPM_SWAP_SLIPPAGE_BPS: boundedInteger(1, 1_000).optional(),
    // Route off-venue only when the quoted saving vs the in-pool swap beats this.
    SFPM_SWAP_MIN_SAVINGS_BPS: boundedBigint(0n, 3_000n, 5n),
    // WETH9 address — required when an options-pool collateral asset is native ETH
    // (the v3 swap pool trades WETH, so the batch wraps/unwraps around the swap).
    WETH_ADDRESS: addressSchema.optional(),
    // Safe MultiSendCallOnly + the Roles MultiSend unwrapper (registered at setup).
    MULTISEND_CALL_ONLY_ADDRESS: addressSchema.optional(),
    MULTISEND_UNWRAPPER_ADDRESS: addressSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const hasKey = Boolean(cfg.BOT_PRIVATE_KEY)
    const hasKeystore = Boolean(cfg.BOT_KEYSTORE_PATH)
    if (hasKey === hasKeystore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasKey ? 'BOT_KEYSTORE_PATH' : 'BOT_PRIVATE_KEY'],
        message: 'set exactly one of BOT_PRIVATE_KEY or BOT_KEYSTORE_PATH',
      })
    }
    if (cfg.BOT_KEYSTORE_PASSPHRASE !== undefined && cfg.BOT_KEYSTORE_PASSPHRASE_FILE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_KEYSTORE_PASSPHRASE_FILE'],
        message: 'set at most one of BOT_KEYSTORE_PASSPHRASE or BOT_KEYSTORE_PASSPHRASE_FILE',
      })
    }
    if (cfg.PRICE_SIGNAL_SOURCE === 'uniswap-pool') {
      if (cfg.UNISWAP_SIGNAL_POOL_VERSION === 'v3' && !cfg.UNISWAP_SIGNAL_POOL_ADDRESS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UNISWAP_SIGNAL_POOL_ADDRESS'],
          message: 'UNISWAP_SIGNAL_POOL_ADDRESS is required for a v3 uniswap-pool signal',
        })
      }
      if (cfg.UNISWAP_SIGNAL_POOL_VERSION === 'v4') {
        if (!cfg.UNISWAP_SIGNAL_STATE_VIEW_ADDRESS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['UNISWAP_SIGNAL_STATE_VIEW_ADDRESS'],
            message: 'UNISWAP_SIGNAL_STATE_VIEW_ADDRESS is required for a v4 uniswap-pool signal',
          })
        }
        if (!cfg.UNISWAP_SIGNAL_POOL_ID) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['UNISWAP_SIGNAL_POOL_ID'],
            message: 'UNISWAP_SIGNAL_POOL_ID is required for a v4 uniswap-pool signal',
          })
        }
      }
    }
    if (cfg.SFPM_SWAP_ENABLED && !cfg.SFPM_SWAP_PROVISIONED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SFPM_SWAP_PROVISIONED'],
        message:
          'SFPM_SWAP_ENABLED=true requires an explicitly provisioned SFPM authorization surface',
      })
    }
    if (cfg.SFPM_SWAP_PROVISIONED) {
      const required: Array<[keyof typeof cfg, string]> = [
        ['SFPM_SWAP_ADDRESS_V3', 'the v3 SFPM the swap runs through'],
        ['SFPM_SWAP_POOL_ADDRESS', 'the cheaper Uniswap v3 pool to swap in'],
        ['MULTISEND_CALL_ONLY_ADDRESS', 'the Safe MultiSendCallOnly address'],
        ['MULTISEND_UNWRAPPER_ADDRESS', 'the Roles MultiSend unwrapper address'],
      ]
      for (const [key, why] of required) {
        if (cfg[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when SFPM_SWAP_PROVISIONED=true (${why})`,
          })
        }
      }
    }
    // CEX_SYMBOL now defaults to ETH-USD, so no required-field check is needed;
    // the ETH/USD(T) pattern is enforced where the cex source is constructed.
    if (cfg.HEDGE_MAX_BASE_FEE_GWEI > cfg.URGENT_MAX_BASE_FEE_GWEI) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['URGENT_MAX_BASE_FEE_GWEI'],
        message: 'URGENT_MAX_BASE_FEE_GWEI must be >= HEDGE_MAX_BASE_FEE_GWEI',
      })
    }
    if (cfg.URGENT_MAX_BASE_FEE_GWEI > cfg.MAX_FEE_GWEI) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_FEE_GWEI'],
        message:
          'MAX_FEE_GWEI must be >= URGENT_MAX_BASE_FEE_GWEI (urgent sends must be able to price in)',
      })
    }
    if (cfg.MIN_PRIORITY_FEE_GWEI > cfg.MAX_PRIORITY_FEE_GWEI) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MIN_PRIORITY_FEE_GWEI'],
        message: 'MIN_PRIORITY_FEE_GWEI must be <= MAX_PRIORITY_FEE_GWEI',
      })
    }
    if (cfg.MIN_PRIORITY_FEE_GWEI > cfg.MAX_FEE_GWEI) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MIN_PRIORITY_FEE_GWEI'],
        message: 'MIN_PRIORITY_FEE_GWEI must be <= MAX_FEE_GWEI (the tip must fit the fee cap)',
      })
    }
    // No check against MAX_PRIORITY_FEE_GWEI on purpose: the urgent floor is
    // allowed to exceed the routine tip ceiling — that is its entire point.
    if (cfg.URGENT_PRIORITY_FEE_GWEI > cfg.MAX_FEE_GWEI) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['URGENT_PRIORITY_FEE_GWEI'],
        message: 'URGENT_PRIORITY_FEE_GWEI must be <= MAX_FEE_GWEI (the tip must fit the fee cap)',
      })
    }
    if (cfg.TX_BUMP_INTERVAL_MS > cfg.TX_RECEIPT_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TX_BUMP_INTERVAL_MS'],
        message:
          'TX_BUMP_INTERVAL_MS must be <= TX_RECEIPT_TIMEOUT_MS (need at least one wait segment)',
      })
    }
    if (cfg.KEEPER_BALANCE_WARN_ETH >= cfg.MIN_KEEPER_BALANCE_ETH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KEEPER_BALANCE_WARN_ETH'],
        message: 'KEEPER_BALANCE_WARN_ETH must be below MIN_KEEPER_BALANCE_ETH',
      })
    }
    if (cfg.TIMED_HEDGE_INTERVAL_MS > 0) {
      if (cfg.TIMED_HEDGE_INTERVAL_MS < 300_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TIMED_HEDGE_INTERVAL_MS'],
          message: 'enabled interval must be at least 300000 (5 minutes)',
        })
      }
      if (
        cfg.TIMED_HEDGE_MIN_DRIFT_BPS <= 0n ||
        cfg.TIMED_HEDGE_MIN_DRIFT_BPS >= cfg.DELTA_THRESHOLD_BPS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TIMED_HEDGE_MIN_DRIFT_BPS'],
          message:
            'must be greater than 0 and below DELTA_THRESHOLD_BPS (timed minimum is the inner band; hard threshold is the outer band)',
        })
      }
    }
    if (cfg.PRICE_SIGNAL_SOURCE === 'cex' && cfg.CEX_MIN_FEEDS < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CEX_MIN_FEEDS'],
        message: 'production CEX mode requires all three independent feeds',
      })
    }
    if (cfg.DELEVERAGER_ROLE_KEY !== undefined && !cfg.DELEVERAGER_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DELEVERAGER_ROLE_KEY'],
        message:
          'is set but DELEVERAGER_ENABLED is false — enable the deleverager or remove the key',
      })
    }
    if (cfg.DELEVERAGER_ENABLED) {
      const effectiveKey = (cfg.DELEVERAGER_ROLE_KEY ?? SDK_DELEVERAGER_ROLE_KEY).toLowerCase()
      if (effectiveKey === cfg.ROLE_KEY.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DELEVERAGER_ROLE_KEY'],
          message: 'must differ from ROLE_KEY (the burn-only key must not be the loan-hedger key)',
        })
      }
    }
    // The deleverage tuning relationships only bind when the feature is enabled.
    if (cfg.DELEVERAGER_ENABLED) {
      if (cfg.DELEVERAGE_TRIGGER_MARGIN_BPS >= cfg.DELEVERAGE_TARGET_MARGIN_BPS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DELEVERAGE_TRIGGER_MARGIN_BPS'],
          message: 'must be below DELEVERAGE_TARGET_MARGIN_BPS (hysteresis needs a gap)',
        })
      }
      if (cfg.DELEVERAGE_TRIGGER_MARGIN_BPS >= cfg.MIN_MARGIN_RESERVE_BPS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DELEVERAGE_TRIGGER_MARGIN_BPS'],
          message:
            'must be below MIN_MARGIN_RESERVE_BPS (emergency burns must trigger only below the mint gate)',
        })
      }
    }

    const hasTgToken = Boolean(cfg.TELEGRAM_BOT_TOKEN)
    const hasTgChat = Boolean(cfg.TELEGRAM_CHAT_ID)
    if (hasTgToken !== hasTgChat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasTgToken ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN'],
        message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set to enable notifications',
      })
    }
  })

export type HedgerBotConfig = z.infer<typeof rawEnvSchema>

/**
 * Effective deleverager role key: the explicit override when set, otherwise the
 * SDK's canonical `roleKey('deleverager')`. Only meaningful when
 * DELEVERAGER_ENABLED (validation rejects an override while disabled).
 */
export function deleveragerRoleKey(
  config: Pick<HedgerBotConfig, 'DELEVERAGER_ROLE_KEY'>,
): `0x${string}` {
  return config.DELEVERAGER_ROLE_KEY ?? SDK_DELEVERAGER_ROLE_KEY
}

/** WETH used to combine native ETH + wrapped ETH wallet exposure. */
export function walletWethAddress(
  config: Pick<HedgerBotConfig, 'CHAIN_ID' | 'WETH_ADDRESS'>,
): `0x${string}` | undefined {
  return config.WETH_ADDRESS ?? getChainDeployment(config.CHAIN_ID)?.sfpmSwap?.weth
}

const REMOVED_CROSS_POOL_KEYS = [
  'HEDGE_VENUE',
  'HEDGE_POOLS',
  'UNIVERSAL_ROUTER_ADDRESS',
  'PERMIT2_ADDRESS',
  'MULTISEND_ADDRESS',
] as const

/**
 * Parse and validate configuration from a raw environment record.
 * Throws a readable aggregated error when validation fails.
 */
export function parseHedgerBotConfig(env: NodeJS.ProcessEnv = process.env): HedgerBotConfig {
  const removed = REMOVED_CROSS_POOL_KEYS.filter((name) =>
    name === 'HEDGE_VENUE' ? env.HEDGE_VENUE === 'cross-pool-uniswap' : env[name] !== undefined,
  )
  if (removed.length > 0) {
    throw new Error(
      `Invalid hedger-bot configuration:\n  - ${removed.join(', ')}: ` +
        'cross-pool execution was removed from the supported runtime',
    )
  }
  const result = rawEnvSchema.safeParse(env)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid hedger-bot configuration:\n${issues}`)
  }
  return result.data
}
