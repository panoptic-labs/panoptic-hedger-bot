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
  .transform((v) => v as `0x${string}`)

const bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 32-byte hex value')
  .transform((v) => v as `0x${string}`)

const privateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 32-byte hex private key')
  .transform((v) => v as `0x${string}`)

const booleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

/** One whitelisted cross-pool hedge venue on the vault's token pair. */
const hedgePoolSchema = z.discriminatedUnion('version', [
  z.object({
    version: z.literal('v4'),
    fee: z.coerce.number().int().nonnegative(),
    tickSpacing: z.coerce.number().int().positive(),
    hooks: addressSchema.optional(),
  }),
  z.object({
    version: z.literal('v3'),
    fee: z.coerce.number().int().nonnegative(),
  }),
])
export type HedgePoolSpec = z.infer<typeof hedgePoolSchema>

/** A JSON array of hedge pools, parsed from the HEDGE_POOLS env string. */
const hedgePoolsSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'HEDGE_POOLS must be valid JSON' })
      return z.NEVER
    }
  })
  .pipe(hedgePoolSchema.array().min(1, 'HEDGE_POOLS must list at least one pool'))

export const PRICE_SIGNAL_SOURCES = ['pool-tick', 'uniswap-pool', 'cex'] as const
export type PriceSignalSourceKind = (typeof PRICE_SIGNAL_SOURCES)[number]

const rawEnvSchema = z
  .object({
    // Chain / RPC
    CHAIN_ID: z.coerce.number().int().positive(),
    RPC_URL: z.string().url(),

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

    // Hedging parameters
    ASSET_INDEX: z.enum(['0', '1']).transform((v) => BigInt(v)),
    DELTA_THRESHOLD_BPS: z.coerce.bigint().positive().default(200n),
    MAX_HEDGE_SLOTS: z.coerce.number().int().positive().default(4),
    SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(30),

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
    CEX_STALE_MS: z.coerce.number().int().positive().default(12_000),
    // Sanity guard: if the price-signal tick and the pool's on-chain tick differ
    // by more than this, the cycle is skipped (a huge gap means the signal is
    // misconfigured — wrong ASSET_INDEX inverts the price, wrong pool, etc. — and
    // dispatching would revert with PriceBoundFail). ~5000 ticks ≈ a 65% price gap.
    SIGNAL_TICK_SANITY_MAX: z.coerce.number().int().positive().default(5_000),
    CEX_MIN_FEEDS: z.coerce.number().int().positive().default(1),

    // Hedge venue: in-pool loan (v1) or cross-pool spot rebalance on another Uniswap pool.
    HEDGE_VENUE: z.enum(['in-pool', 'cross-pool-uniswap']).default('in-pool'),
    // cross-pool-uniswap: a JSON whitelist of Uniswap pools on the SAME token pair
    // as the vault. The bot best-quotes across all of them each cycle and swaps
    // the winner; the same list scopes UniversalRouter.execute (see routerScope).
    // v4 entry: {"version":"v4","fee":500,"tickSpacing":10,"hooks":"0x.."}
    // v3 entry: {"version":"v3","fee":3000}
    HEDGE_POOLS: hedgePoolsSchema.optional(),
    UNIVERSAL_ROUTER_ADDRESS: addressSchema.optional(),
    PERMIT2_ADDRESS: addressSchema.optional(),
    MULTISEND_ADDRESS: addressSchema.optional(),

    // Gas policy (keeper EOA pays all gas — no Safe refund).
    // Hard EIP-1559 caps applied to every send:
    MAX_FEE_GWEI: z.coerce.number().positive().default(400),
    MAX_PRIORITY_FEE_GWEI: z.coerce.number().positive().default(2),
    // Two-tier deferral: routine hedges wait out basefee spikes; urgent hedges
    // (drift >= URGENT_DRIFT_MULTIPLIER x DELTA_THRESHOLD_BPS) tolerate more.
    HEDGE_MAX_BASE_FEE_GWEI: z.coerce.number().positive().default(50),
    URGENT_MAX_BASE_FEE_GWEI: z.coerce.number().positive().default(300),
    URGENT_DRIFT_MULTIPLIER: z.coerce.number().positive().default(3),
    // The keeper's target minimum ETH — shown in the low-gas alert as the level
    // to top back up to. NOT the alert trigger (see KEEPER_BALANCE_WARN_ETH).
    MIN_KEEPER_BALANCE_ETH: z.coerce.number().positive().default(0.05),
    // Only warn/alert once the keeper EOA's ETH actually falls below this — keeps
    // routine balances above the warn line from spamming the log every poll.
    KEEPER_BALANCE_WARN_ETH: z.coerce.number().positive().default(0.015),
    // Give up waiting for a dispatch receipt after this long (alert; the next
    // cycle re-reads chain state and reconciles).
    TX_RECEIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),

    // Loop
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    DRY_RUN: booleanSchema.default('false'),

    // Optional
    PANOPTIC_BUILDER_CODE: z.string().optional(),
    // Telegram notifications (both required together to enable).
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
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
    // CEX_SYMBOL now defaults to ETH-USD, so no required-field check is needed;
    // the ETH/USD(T) pattern is enforced where the cex source is constructed.
    if (cfg.HEDGE_VENUE === 'cross-pool-uniswap') {
      const missing = (
        [
          ['HEDGE_POOLS', cfg.HEDGE_POOLS],
          ['UNIVERSAL_ROUTER_ADDRESS', cfg.UNIVERSAL_ROUTER_ADDRESS],
          ['PERMIT2_ADDRESS', cfg.PERMIT2_ADDRESS],
          ['MULTISEND_ADDRESS', cfg.MULTISEND_ADDRESS],
        ] as const
      ).filter(([, v]) => v === undefined || v === null)
      for (const [name] of missing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} is required when HEDGE_VENUE='cross-pool-uniswap'`,
        })
      }
    }
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
 * Parse and validate configuration from a raw environment record.
 * Throws a readable aggregated error when validation fails.
 */
export function parseHedgerBotConfig(env: NodeJS.ProcessEnv = process.env): HedgerBotConfig {
  const result = rawEnvSchema.safeParse(env)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid hedger-bot configuration:\n${issues}`)
  }
  return result.data
}
