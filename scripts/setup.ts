import 'dotenv/config'

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getChainDeployment,
  getPool,
  getPoolMetadata,
  isSupportedChain,
} from '@panoptic-eng/sdk/v2'
import { DELEVERAGER_ROLE_KEY } from '@panoptic-eng/sdk/zodiac'
import {
  type PublicClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isHex,
  size,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'

import {
  DEFAULT_LP_SUBGRAPH_MAX_LAG_BLOCKS,
  DEFAULT_LP_SUBGRAPH_URL,
  parseHedgerBotConfig,
} from '../src/config'
import { readSafeLpPositions } from '../src/hedge/lpPositions'
import {
  readSecureJson,
  removeSecureFile,
  writeSecureJson,
  writeSecureText,
} from '../src/runtime/secureFile'
import { assertBotIsNotSafeOwner, BotIsSafeOwnerError } from '../src/security/safeOwnerInvariant'
import { defineBotChain } from '../src/utils/chain'
import { deriveBotPrivateKey } from '../src/utils/entropy'
import {
  decryptKeystore,
  encryptKeystore,
  isKeystorePassphraseMismatch,
  keystoreV3Schema,
} from '../src/utils/keystore'
import { sanitizeError } from '../src/utils/sanitize'
import { asSdkClient } from '../src/utils/sdkClient'
import { runGenerateIdea } from './generateIdea'
import {
  type ExtraRoleKind,
  type ExtraRoleSpec,
  buildSafeSetupInitializer,
  deploySafeAndRoles,
} from './lib/deployCore'
import { configureExistingSafe, readSafeOwners } from './lib/existingSafe'
import { loadKeystorePrivateKey } from './lib/loadKeystorePrivateKey'
import { Prompter, validateAddress, validatePrivateKey, validateUrl } from './lib/prompts'
import { type EnvValues, renderEnvFile } from './lib/renderEnv'
import {
  getSafeZodiacAddresses,
  SAFE_ZODIAC_ADDRESSES,
  verifySafeZodiacBytecode,
} from './lib/safeZodiacRegistry'
import {
  expectedAttempts,
  fetchProxyCreationCode,
  mineVanitySafeSalt,
  normalizeVanityPrefix,
  validateVanityPrefix,
} from './lib/vanitySafe'
import { verifyDeleveragerScope, verifyLoanOnlyScope } from './lib/verifyScope'

/**
 * Turnkey interactive setup: prompt for essentials → auto-derive the rest →
 * persist the bot key BEFORE any funds are requested → deploy a fresh Safe +
 * Roles modifier in ~3 txs → verify the loan-only scope → write a complete
 * `.env`. Run:  pnpm onboard  (add --resume to continue an interrupted run,
 * --force to overwrite an existing .env).
 */

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'FRAX', 'LUSD', 'GUSD'])
const KEYSTORE_PATH = path.resolve(process.cwd(), 'bot-keystore.json')
const STATE_PATH = path.resolve(process.cwd(), 'deploy-state.json')

function randomBytes32(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`
}

function randomSaltNonce(): bigint {
  return BigInt(`0x${randomBytes(8).toString('hex')}`)
}

/**
 * Everything needed to persist the bot key + resume an interrupted deployment.
 * Written (mode 0600) BEFORE the bot is funded, so a crash can never strand
 * funds at an unrecoverable address. `sizeCap`/`saltNonce` are stringified
 * because JSON has no bigint.
 */
interface DeployState {
  version: 1
  /** 'new' = bot deploys a fresh Safe; 'existing' = wire onto a user-owned Safe. */
  safeMode: 'new' | 'existing'
  chainId: number
  rpcUrl: string
  poolAddress: `0x${string}`
  /** Only set in 'new' mode — the address the bot hands Safe ownership to. */
  finalSafeOwner?: `0x${string}`
  botAddress: `0x${string}`
  roleKey: `0x${string}`
  saltNonce: string
  assetIndex: 0 | 1
  deltaThresholdBps?: number
  deltaOffset?: number
  dryRun: boolean
  /** Extra LP-holding address scanned alongside the Safe. */
  uniswapLpOwner?: `0x${string}`
  /** Fold Uniswap LP delta into the hedge (vs observe-only). */
  hedgeIncludeLp: boolean
  storage: 'keystore' | 'plaintext'
  extraRoles: { kind: ExtraRoleKind; member: `0x${string}`; sizeCap?: string }[]
  /** Filled in by onDeployed as each contract lands, for a clean resume. */
  safeAddress?: `0x${string}`
  rolesModifierAddress?: `0x${string}`
}

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value))
export const deployStateSchema: z.ZodType<DeployState, z.ZodTypeDef, unknown> = z
  .object({
    version: z.literal(1),
    safeMode: z.enum(['new', 'existing']),
    chainId: z.number().int().positive(),
    rpcUrl: z.string().url(),
    poolAddress: addressSchema,
    finalSafeOwner: addressSchema.optional(),
    botAddress: addressSchema,
    roleKey: z
      .string()
      .refine(
        (value): value is `0x${string}` => isHex(value) && size(value) === 32,
        'role key must be 32-byte hex',
      ),
    saltNonce: z.string().regex(/^(0|[1-9]\d*)$/),
    assetIndex: z.union([z.literal(0), z.literal(1)]),
    deltaThresholdBps: z.number().int().positive().optional(),
    deltaOffset: z.number().int().optional(),
    dryRun: z.boolean(),
    uniswapLpOwner: addressSchema.optional(),
    // Optional for resume compatibility: a version-1 state file written before
    // LP hedging existed has no hedgeIncludeLp; default it to observe-only.
    hedgeIncludeLp: z.boolean().optional().default(false),
    storage: z.enum(['keystore', 'plaintext']),
    extraRoles: z.array(
      z
        .object({
          kind: z.enum(['deleverager', 'maintenance', 'roller', 'size-adjuster']),
          member: addressSchema,
          sizeCap: z
            .string()
            .regex(/^(0|[1-9]\d*)$/)
            .optional(),
        })
        .strict(),
    ),
    safeAddress: addressSchema.optional(),
    rolesModifierAddress: addressSchema.optional(),
  })
  .strict()

async function writeState(state: DeployState): Promise<void> {
  writeSecureJson(STATE_PATH, deployStateSchema, state)
}

async function readState(): Promise<DeployState> {
  const state = readSecureJson(STATE_PATH, deployStateSchema, {
    maxBytes: 32_768,
    invalid: 'throw',
  })
  if (!state) throw new Error('resume state does not exist')
  return state
}

function toExtraRoleSpecs(state: DeployState): ExtraRoleSpec[] {
  return state.extraRoles.map((r) => ({
    kind: r.kind,
    member: r.member,
    sizeCap: r.sizeCap === undefined ? undefined : BigInt(r.sizeCap),
  }))
}

interface TargetInput {
  chainId: number
  rpcUrl: string
  poolAddress: `0x${string}`
}

async function collectTargetInput(p: Prompter): Promise<TargetInput> {
  const supportedChains = Object.keys(SAFE_ZODIAC_ADDRESSES)
    .map(Number)
    .filter((id) => isSupportedChain(id))
  const chainChoices = [
    ...supportedChains.map((id) => ({ label: `chain ${id}`, value: String(id) })),
    { label: 'other (manual — requires Safe/Zodiac env overrides)', value: 'other' },
  ]
  const picked = await p.choice('Target chain:', chainChoices, chainChoices[0]?.value as string)
  const chainId =
    picked === 'other'
      ? Number(
          await p.text('CHAIN_ID', {
            validate: (value) =>
              Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : 'positive integer',
          }),
        )
      : Number(picked)

  return {
    chainId,
    rpcUrl: await p.text('RPC_URL', { validate: validateUrl }),
    poolAddress: (await p.text('POOL_ADDRESS (PanopticPool)', {
      validate: validateAddress,
    })) as `0x${string}`,
  }
}

interface SafeSetupInput {
  safeMode: 'new' | 'existing'
  finalSafeOwner?: `0x${string}`
  existingSafeAddress?: `0x${string}`
  existingRolesModifier?: `0x${string}`
  existingRoleKey?: `0x${string}`
}

async function collectSafeSetupInput(p: Prompter): Promise<SafeSetupInput> {
  const safeMode = (await p.choice(
    'Safe setup:',
    [
      { label: 'Deploy a new Safe (recommended)', value: 'new' },
      { label: 'Use an existing Safe I control', value: 'existing' },
    ],
    'new',
  )) as SafeSetupInput['safeMode']

  if (safeMode === 'new') {
    return {
      safeMode,
      finalSafeOwner: (await p.text(
        'Safe owner address (Ledger / MetaMask / Rabby — controls the Safe, NOT the bot)',
        { validate: validateAddress },
      )) as `0x${string}`,
    }
  }

  const existingSafeAddress = (await p.text('SAFE_ADDRESS (a Safe you already control)', {
    validate: validateAddress,
  })) as `0x${string}`
  const rolesModifier = await p.text('ROLES_MODIFIER_ADDRESS (leave blank to deploy a new one)', {
    default: '',
    validate: (value) =>
      value === '' || /^0x[a-fA-F0-9]{40}$/.test(value)
        ? undefined
        : 'a 20-byte hex address, or blank',
  })
  const existingRolesModifier = rolesModifier === '' ? undefined : (rolesModifier as `0x${string}`)
  const existingRoleKey = existingRolesModifier
    ? ((await p.text('ROLE_KEY (the bot role on that modifier, 0x… 32 bytes)', {
        validate: (value) =>
          /^0x[a-fA-F0-9]{64}$/.test(value) ? undefined : 'a 32-byte hex role key',
      })) as `0x${string}`)
    : undefined

  return { safeMode, existingSafeAddress, existingRolesModifier, existingRoleKey }
}

interface BotSignerInput {
  botMode: 'generate' | 'import' | 'keystore'
  botKey: `0x${string}`
  botStorage: 'keystore' | 'plaintext'
  keystorePassphrase?: string
}

async function collectBotSignerInput(p: Prompter): Promise<BotSignerInput> {
  const botMode = await p.choice(
    'Bot signer key:',
    [
      { label: 'generate a new key', value: 'generate' },
      { label: 'import an existing key', value: 'import' },
      ...(existsSync(KEYSTORE_PATH)
        ? [{ label: 'reuse bot-keystore.json', value: 'keystore' as const }]
        : []),
    ],
    existsSync(KEYSTORE_PATH) ? 'keystore' : 'generate',
  )

  let botKey: `0x${string}`
  if (botMode === 'keystore') {
    botKey = await loadKeystorePrivateKey(
      KEYSTORE_PATH,
      () => p.secret('Existing keystore passphrase'),
      () => console.log('  ✗ wrong passphrase or MAC mismatch — try again'),
    )
  } else if (botMode === 'import') {
    botKey = (await p.secret('BOT_PRIVATE_KEY', validatePrivateKey)) as `0x${string}`
  } else {
    const userEntropy = (await p.confirm('Add your own extra entropy? (optional, advanced)', false))
      ? await p.secret('Extra entropy (any text)')
      : ''
    botKey = deriveBotPrivateKey(userEntropy, randomBytes(32))
  }

  if (botMode === 'keystore') {
    return { botMode, botKey, botStorage: 'keystore' }
  }

  const botStorage = await p.choice(
    'Store the bot key as:',
    [
      { label: 'passphrase-encrypted keystore file (recommended)', value: 'keystore' },
      { label: 'plaintext in .env', value: 'plaintext' },
    ],
    'keystore',
  )
  for (;;) {
    const passphrase = await p.secret(
      botStorage === 'keystore'
        ? 'Keystore passphrase (min 12 chars)'
        : 'Encrypted resume passphrase (min 12 chars)',
      (value) => (value.length >= 12 ? undefined : 'at least 12 characters'),
    )
    if (passphrase !== (await p.secret('Confirm passphrase'))) {
      console.log('  ✗ passphrases do not match — try again')
      continue
    }
    console.log('  ⚠️  If you lose this passphrase, interrupted onboarding cannot be resumed.')
    return { botMode, botKey, botStorage, keystorePassphrase: passphrase }
  }
}

function fail(
  phase: string,
  err: unknown,
  opts: { keyPersisted: boolean; funded: boolean },
): never {
  console.error(`\n✗ Setup failed during "${phase}".`)
  if (opts.keyPersisted) {
    console.error(
      `\n  ✓ The bot key IS saved (${KEYSTORE_PATH} / ${STATE_PATH}) — no funds can be lost.` +
        `\n  Once any pending tx confirms, resume with:  pnpm onboard --resume` +
        `\n  (reuses the same key + salt, skips work already done on-chain).`,
    )
  } else if (opts.funded) {
    console.error(
      '\n  ⚠️  The bot may have been funded before the key was saved — check the bot EOA balance.',
    )
  } else {
    console.error('  Nothing was deployed and no funds were sent.')
  }
  console.error(`\n${sanitizeError(err)}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const resume = process.argv.includes('--resume')
  const envPath = path.resolve(process.cwd(), '.env')

  if (existsSync(envPath) && !force && !resume) {
    console.error(`.env already exists at ${envPath}. Re-run with --force to overwrite.`)
    process.exit(1)
  }

  const p = new Prompter()

  // ---- Resume path: continue an interrupted run from deploy-state.json --------
  if (resume || (existsSync(STATE_PATH) && !force)) {
    if (!existsSync(STATE_PATH)) {
      console.error(`No ${STATE_PATH} to resume from. Run without --resume for a fresh setup.`)
      process.exit(1)
    }
    if (!resume) {
      console.log(`\n Found an interrupted deployment (${STATE_PATH}).`)
      if (!(await p.confirm(' Resume it (reuses the saved key + salt)?', true))) {
        console.error(
          ' Not resuming. Delete deploy-state.json to start fresh, or pass --resume to continue.',
        )
        p.close()
        process.exit(1)
      }
    }
    try {
      await runResume(p, await readState(), envPath)
      p.close()
      return
    } catch (err) {
      p.close()
      fail('resume', err, { keyPersisted: true, funded: true })
    }
  }

  let keyPersisted = false
  let funded = false
  try {
    console.log('\n Hedger-bot setup — wires a loan-only Safe + Roles modifier and writes .env.\n')

    // ---- Phase A: prompt (no chain writes) ----------------------------------
    const { chainId, rpcUrl, poolAddress } = await collectTargetInput(p)
    const {
      safeMode,
      finalSafeOwner,
      existingSafeAddress,
      existingRolesModifier,
      existingRoleKey,
    } = await collectSafeSetupInput(p)
    const { botMode, botKey, botStorage, keystorePassphrase } = await collectBotSignerInput(p)
    const botAccount = privateKeyToAccount(botKey)
    console.log(
      `  → Bot EOA is ${botAccount.address} (deploys, then runs hedging — fund it with gas)`,
    )

    const deltaThresholdBps = Number(
      await p.text('DELTA_THRESHOLD_BPS (rehedge trigger)', { default: '200' }),
    )
    const deltaOffset = Number(
      await p.text('DELTA_OFFSET_BPS (target delta bias, bps; 0 = neutral, +long / -short)', {
        default: '0',
      }),
    )
    const dryRun = await p.confirm('Start in DRY_RUN (simulate, send nothing)?', true)

    // Optional: an extra address (besides the Safe) holding plain Uniswap v3/v4
    // LP positions on this pool's token pair. Recorded as UNISWAP_LP_OWNER and
    // scanned alongside the Safe. Enter to skip.
    const lpOwnerRaw = (
      await p.text('UNISWAP_LP_OWNER (extra LP-holding address; Enter to skip)', {
        default: '',
      })
    ).trim()
    let uniswapLpOwner: `0x${string}` | undefined
    if (lpOwnerRaw !== '') {
      const parsed = addressSchema.safeParse(lpOwnerRaw)
      if (parsed.success) {
        uniswapLpOwner = parsed.data
      } else {
        console.log('  → Ignoring UNISWAP_LP_OWNER: not a valid address.')
      }
    }

    // The fold-vs-observe decision is deferred to Phase B, where we can read the
    // chain and preview the operator's actual LP exposure before offering it.

    // Telegram alerts are optional and configured out-of-band: set TELEGRAM_BOT_TOKEN
    // and TELEGRAM_CHAT_ID in .env after onboarding (see README). The wizard no
    // longer walks through BotFather so it stays focused on the on-chain setup.
    // The onboard wizard deploys a loan-only bot plus, opt-in, the bot-held
    // burn-only deleverager role (every positionSizes entry must be 0 —
    // burn-or-revert; it can never mint or move funds). The other à-la-carte
    // keeper roles (maintenance / roller / size-adjuster) have no consumer in
    // this bot's runtime, so they are not offered here. Advanced operators can
    // still scope them onto an existing modifier later with `pnpm manage-role`
    // (see README).
    const withDeleverager = await p.confirm(
      'Provision the emergency deleverager role? (burn-only: lets the bot force-close ' +
        'positions when the account nears liquidation, instead of only alerting)',
      false,
    )
    const extraRoles: ExtraRoleSpec[] = withDeleverager
      ? [{ kind: 'deleverager', member: botAccount.address }]
      : []

    // Optional: mine a vanity Safe address. The Safe is a CREATE2 proxy whose
    // address is fixed by the saltNonce (given this deployer + chain), so salts
    // can be searched locally — no chain writes — for an address with a chosen
    // hex prefix, before anything is deployed. Purely cosmetic; each extra hex
    // character makes the search ~16x slower. Mined in Phase B (needs the
    // factory), controlled by this prefix.
    // Vanity mining only applies when the bot deploys the Safe (an existing Safe
    // already has its address).
    let vanityPrefix: string | undefined
    if (
      safeMode === 'new' &&
      (await p.confirm('Mine a vanity Safe address (search for a chosen hex prefix)?', false))
    ) {
      const raw = await p.text(
        '  Desired Safe address prefix after 0x (hex, e.g. "beef", up to 6)',
        {
          validate: (v) => validateVanityPrefix(v),
        },
      )
      vanityPrefix = normalizeVanityPrefix(raw)
      const est = expectedAttempts(vanityPrefix.length)
      console.log(
        `  → target 0x${vanityPrefix}…  (~${est.toLocaleString()} salts on average` +
          `${vanityPrefix.length > 5 ? ' — this can take several minutes' : ''})`,
      )
    }

    const roleKey = existingRoleKey ?? randomBytes32()
    let saltNonce = randomSaltNonce()

    // ---- Phase B: derive (reads only) ---------------------------------------
    console.log('\n Deriving config from chain + pool…')
    const chain = defineBotChain(chainId, rpcUrl)
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

    const rpcChainId = await publicClient.getChainId().catch((e) => {
      throw new Error(`RPC unreachable: ${sanitizeError(e)}`)
    })
    if (rpcChainId !== chainId) {
      throw new Error(`RPC reports chainId ${rpcChainId}, but you selected ${chainId}.`)
    }

    if (!getChainDeployment(chainId)) {
      console.log(`  ⚠️  No Panoptic deployment record for chain ${chainId} — continuing anyway.`)
    }

    const metadata = await getPoolMetadata({
      client: asSdkClient<typeof getPoolMetadata>(publicClient),
      poolAddress,
    }).catch((e) => {
      throw new Error(
        `Could not read pool metadata at ${poolAddress} — is it a PanopticPool on chain ${chainId}? ` +
          sanitizeError(e),
      )
    })
    console.log(
      `  → pool: ${metadata.token0Symbol}/${metadata.token1Symbol} ` +
        `(token0=${metadata.token0Asset}, token1=${metadata.token1Asset})`,
    )

    // Suggest the option-sizing (non-numeraire) asset: the non-stable side.
    const token0Stable = STABLE_SYMBOLS.has(metadata.token0Symbol.toUpperCase())
    const token1Stable = STABLE_SYMBOLS.has(metadata.token1Symbol.toUpperCase())
    const suggestedAssetIndex: 0 | 1 = token0Stable && !token1Stable ? 1 : token1Stable ? 0 : 1
    const assetIndex = Number(
      await p.choice(
        `ASSET_INDEX (option-sizing token). Suggested: ${suggestedAssetIndex} (${
          suggestedAssetIndex === 0 ? metadata.token0Symbol : metadata.token1Symbol
        })`,
        [
          { label: `0 — ${metadata.token0Symbol}`, value: '0' },
          { label: `1 — ${metadata.token1Symbol}`, value: '1' },
        ],
        String(suggestedAssetIndex) as '0' | '1',
      ),
    ) as 0 | 1

    // LP fold decision (deferred from Phase A): now that we can read the chain,
    // preview the operator's detected same-pair LP exposure before offering to
    // fold it into the hedge. A brand-new Safe holds nothing yet, so we only
    // preview/offer when an address could already hold LP: the configured
    // UNISWAP_LP_OWNER and/or an existing Safe. Persist HEDGE_INCLUDE_LP=true
    // only after the operator confirms against real numbers; else observe-only.
    let hedgeIncludeLp = false
    const lpPreviewOwners = [
      ...(uniswapLpOwner ? [uniswapLpOwner] : []),
      ...(safeMode === 'existing' && existingSafeAddress ? [existingSafeAddress] : []),
    ]
    if (lpPreviewOwners.length === 0) {
      console.log(
        '  → Uniswap LP fold: observe-only for now (no existing LP-holding address to preview).\n' +
          '    Enable HEDGE_INCLUDE_LP later after verifying with `pnpm inspect:hedge`.',
      )
    } else {
      try {
        const [chainHead, pool] = await Promise.all([
          publicClient.getBlockNumber(),
          getPool({
            client: asSdkClient<typeof getPool>(publicClient),
            poolAddress,
            chainId: BigInt(chainId),
          }),
        ])
        const lp = await readSafeLpPositions({
          url: DEFAULT_LP_SUBGRAPH_URL,
          owners: lpPreviewOwners,
          token0: pool.poolKey.currency0,
          token1: pool.poolKey.currency1,
        })
        const lag = chainHead > lp.headBlock ? chainHead - lp.headBlock : 0n
        const fresh = lp.ok && lp.headBlock > 0n && lag <= DEFAULT_LP_SUBGRAPH_MAX_LAG_BLOCKS
        console.log('\n Uniswap LP exposure (same pool pair):')
        console.log(`   • owners scanned: ${lpPreviewOwners.join(', ')}`)
        console.log(
          `   • same-pair LP positions: ${lp.ok ? lp.positions.length : 'subgraph unavailable'}`,
        )
        console.log(
          `   • subgraph: head=${lp.headBlock} chain=${chainHead} lag=${lag} ` +
            `(${fresh ? 'fresh' : 'STALE / still syncing'})`,
        )
        if (lp.ok && lp.positions.length > 0) {
          hedgeIncludeLp = await p.confirm(
            'Fold this Uniswap LP delta into the hedge? (No = observe-only; you can enable later)',
            false,
          )
        } else {
          console.log(
            '   → Nothing to fold yet — keeping observe-only. Re-check with `pnpm inspect:hedge`.',
          )
        }
      } catch (err) {
        console.log(
          `   → Could not preview LP exposure (${sanitizeError(err)}); keeping observe-only.`,
        )
      }
    }

    const addresses = getSafeZodiacAddresses(chainId)
    await verifySafeZodiacBytecode(publicClient, addresses)
    console.log('  → Safe/Zodiac infrastructure verified on-chain.')

    // Existing-Safe: confirm the address is actually a Safe and show its owners
    // (the bot must NOT be one — it only ever gets a scoped role).
    if (safeMode === 'existing' && existingSafeAddress) {
      const owners = await assertBotIsNotSafeOwner(
        publicClient,
        existingSafeAddress,
        botAccount.address,
      ).catch((e) => {
        if (e instanceof BotIsSafeOwnerError) throw e
        throw new Error(
          `${existingSafeAddress} does not look like a Safe (getOwners failed): ` +
            sanitizeError(e),
        )
      })
      console.log(`  → Safe owners: ${owners.join(', ')}`)
    }

    // Mine the vanity saltNonce now that the factory + deployer are known. The
    // predicted address matches what createProxyWithNonce will emit (same owner
    // initializer + salt), so the deployed Safe below carries the prefix.
    if (vanityPrefix) {
      console.log(`\n Mining a Safe address starting 0x${vanityPrefix}… (Ctrl-C to skip)`)
      const proxyCreationCode = await fetchProxyCreationCode(
        publicClient,
        addresses.safeProxyFactory,
      )
      const initializer = buildSafeSetupInitializer(botAccount.address)
      const startedAt = Date.now()
      const mined = await mineVanitySafeSalt({
        factory: addresses.safeProxyFactory,
        singleton: addresses.safeSingleton,
        initializer,
        proxyCreationCode,
        prefix: vanityPrefix,
        start: saltNonce,
        onProgress: (attempts) => {
          const secs = Math.max((Date.now() - startedAt) / 1000, 0.001)
          const rate = Math.round(attempts / secs)
          process.stdout.write(
            `\r  … ${attempts.toLocaleString()} salts tried (${rate.toLocaleString()}/s)`,
          )
        },
      })
      process.stdout.write('\n')
      saltNonce = mined.saltNonce
      console.log(
        `  ✓ ${mined.address} after ${mined.attempts.toLocaleString()} salts ` +
          `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
      )
    }

    // ---- Phase C: deploy (writes) -------------------------------------------
    if (safeMode === 'new') {
      console.log('\n About to deploy (≈3 transactions):')
      console.log(`   • Safe (owner ${finalSafeOwner}, threshold 1) — deployed by the bot`)
      console.log(`   • Zodiac Roles v2 modifier scoped loan-only to pool ${poolAddress}`)
      console.log(`   • bot ${botAccount.address} assigned to role ${roleKey}`)
      console.log(`   • then Safe ownership handed to ${finalSafeOwner} (bot keeps only its role)`)
    } else {
      console.log('\n About to configure your EXISTING Safe:')
      console.log(`   • Safe: ${existingSafeAddress}`)
      console.log(
        existingRolesModifier
          ? `   • Using your Roles modifier ${existingRolesModifier}`
          : '   • Bot will deploy a new Zodiac Roles v2 modifier (owner = your Safe)',
      )
      console.log(
        `   • bot ${botAccount.address} assigned to role ${roleKey}, scoped loan-only to ${poolAddress}`,
      )
      console.log(
        '   • You then execute the enable/scope tx(s) from your Safe owner in the Safe UI',
      )
    }
    if (uniswapLpOwner || hedgeIncludeLp) {
      console.log('\n Uniswap LP hedging:')
      console.log(
        `   • Scanning for same-pair LP positions: Safe${
          uniswapLpOwner ? ` + ${uniswapLpOwner}` : ' only'
        }`,
      )
      console.log(
        hedgeIncludeLp
          ? '   • LP delta will be FOLDED into the hedge (once the subgraph is fresh)'
          : '   • LP delta is OBSERVE-ONLY (logged, not hedged) — flip HEDGE_INCLUDE_LP later to apply',
      )
    }
    if (!(await p.confirm('\n Proceed?', false))) {
      console.log('Aborted. Nothing was deployed.')
      p.close()
      return
    }

    // Persist the bot key + resume state BEFORE asking for funds. From here on a
    // crash can never strand ETH at an unrecoverable address.
    const botKeystorePath = botStorage === 'keystore' ? KEYSTORE_PATH : undefined
    if (botMode !== 'keystore') {
      if (!keystorePassphrase) throw new Error('keystore passphrase was not collected')
      // A new/imported key would overwrite an existing keystore in place, which
      // could destroy the only copy of a funded key. Require explicit consent.
      if (botStorage === 'keystore' && existsSync(KEYSTORE_PATH)) {
        if (!(await p.confirm(`Overwrite existing keystore ${KEYSTORE_PATH}?`, false))) {
          throw new Error('aborted: existing keystore preserved (re-run and choose "reuse")')
        }
      }
      const keystore = encryptKeystore(botKey, keystorePassphrase)
      writeSecureJson(KEYSTORE_PATH, keystoreV3Schema, keystore)
      console.log(`✓ Wrote encrypted recovery keystore ${KEYSTORE_PATH}`)
    } else {
      console.log(`✓ Reusing encrypted bot keystore ${KEYSTORE_PATH} without rewriting it`)
    }
    const state: DeployState = {
      version: 1,
      safeMode,
      chainId,
      rpcUrl,
      poolAddress,
      finalSafeOwner,
      botAddress: botAccount.address,
      roleKey,
      saltNonce: saltNonce.toString(),
      assetIndex,
      deltaThresholdBps: Number.isFinite(deltaThresholdBps) ? deltaThresholdBps : undefined,
      deltaOffset: Number.isFinite(deltaOffset) ? deltaOffset : undefined,
      dryRun,
      uniswapLpOwner,
      hedgeIncludeLp,
      storage: botStorage,
      extraRoles: extraRoles.map((r) => ({
        kind: r.kind,
        member: r.member,
        sizeCap: r.sizeCap?.toString(),
      })),
      // Existing-Safe: seed the known addresses so finalizeDeployment wires them.
      safeAddress: existingSafeAddress,
      rolesModifierAddress: existingRolesModifier,
    }
    await writeState(state)
    keyPersisted = true
    console.log(`✓ Saved resume state ${STATE_PATH} — safe to fund the bot now.`)

    // The bot pays gas for the on-chain deploy tx(s). New-Safe always needs it;
    // existing-Safe only needs it to deploy the Roles modifier (skip when the
    // user supplied one — the owner then pays for the enable/scope tx(s)).
    const botDeploysOnChain = safeMode === 'new' || !existingRolesModifier
    if (botDeploysOnChain) {
      for (;;) {
        const balance = await publicClient.getBalance({ address: botAccount.address })
        if (balance > 0n) {
          console.log(`  → bot balance: ${formatEther(balance)} ETH`)
          funded = true
          break
        }
        console.log(
          `\n  Fund the bot ${botAccount.address} with ETH for gas (≈0.01 ETH covers setup).`,
        )
        if (!(await p.confirm('  Re-check balance?', true))) {
          throw new Error('bot not funded')
        }
      }
    } else {
      console.log(
        `\n  No bot setup gas needed (reusing your modifier). Keep the bot ` +
          `${botAccount.address} topped up for ongoing hedging.`,
      )
    }

    await finalizeDeployment({
      state,
      botKey,
      keystorePath: botKeystorePath,
      poolId: metadata.poolId,
      envPath,
      prompter: p,
    })
    p.close()
  } catch (err) {
    p.close()
    fail('setup', err, { keyPersisted, funded })
  }
}

/** Resume an interrupted deployment from a saved DeployState. */
async function runResume(p: Prompter, state: DeployState, envPath: string): Promise<void> {
  console.log(`\n Resuming deployment on chain ${state.chainId} (pool ${state.poolAddress}).`)

  if (!existsSync(KEYSTORE_PATH)) {
    throw new Error(`encrypted recovery keystore ${KEYSTORE_PATH} missing — cannot resume`)
  }
  const keystore = readSecureJson(KEYSTORE_PATH, keystoreV3Schema, {
    maxBytes: 16_384,
    invalid: 'throw',
  })
  if (!keystore) throw new Error('encrypted recovery keystore does not exist')
  let botKey: `0x${string}`
  for (;;) {
    const pass = await p.secret('Recovery keystore passphrase')
    try {
      botKey = decryptKeystore(keystore, pass)
      break
    } catch (error) {
      if (!isKeystorePassphraseMismatch(error)) throw error
      console.log('  ✗ wrong passphrase or MAC mismatch — try again')
    }
  }
  const keystorePath = state.storage === 'keystore' ? KEYSTORE_PATH : undefined
  const botAccount = privateKeyToAccount(botKey)
  if (botAccount.address.toLowerCase() !== state.botAddress.toLowerCase()) {
    throw new Error('recovered key does not match the saved bot address')
  }

  const metadata = await (async () => {
    const chain = defineBotChain(state.chainId, state.rpcUrl)
    const publicClient = createPublicClient({ chain, transport: http(state.rpcUrl) })
    return getPoolMetadata({
      client: asSdkClient<typeof getPoolMetadata>(publicClient),
      poolAddress: state.poolAddress,
    })
  })()

  console.log(`  → resuming as bot ${botAccount.address}`)
  await finalizeDeployment({
    state,
    botKey,
    keystorePath,
    poolId: metadata.poolId,
    envPath,
    prompter: p,
  })
}

/**
 * Shared tail for the fresh + resume paths: run the (resumable, batched) deploy,
 * verify the loan-only boundary, write `.env`, and clear the resume state.
 */
async function finalizeDeployment(args: {
  state: DeployState
  botKey: `0x${string}`
  keystorePath?: string
  poolId: bigint
  envPath: string
  prompter: Prompter
}): Promise<void> {
  const { state, botKey, keystorePath, poolId, envPath, prompter } = args
  const chain = defineBotChain(state.chainId, state.rpcUrl)
  const publicClient = createPublicClient({ chain, transport: http(state.rpcUrl) })
  const botAccount = privateKeyToAccount(botKey)
  const walletClient = createWalletClient({
    account: botAccount,
    chain,
    transport: http(state.rpcUrl),
  })
  const addresses = getSafeZodiacAddresses(state.chainId)

  let result: {
    safeAddress: `0x${string}`
    rolesModifierAddress: `0x${string}`
    roleKey: `0x${string}`
    safeOwner: string
    safeTxHash?: `0x${string}`
    rolesTxHash?: `0x${string}`
    configureTxHash?: `0x${string}`
  }
  if (state.safeMode === 'existing') {
    if (!state.safeAddress) throw new Error('existing-Safe resume state missing safeAddress')
    const wired = await configureExistingSafe({
      publicClient,
      walletClient,
      prompter,
      addresses,
      safeAddress: state.safeAddress,
      rolesModifierAddress: state.rolesModifierAddress,
      botAddress: botAccount.address,
      roleKey: state.roleKey,
      poolAddress: state.poolAddress,
      poolId,
      extraRoles: toExtraRoleSpecs(state),
      saltNonce: BigInt(state.saltNonce),
      // Persist the modifier address as soon as it lands, for a clean resume.
      onModifierDeployed: async (rolesModifierAddress) => {
        state.rolesModifierAddress = rolesModifierAddress
        await writeState(state)
      },
    })
    const owners = await readSafeOwners(publicClient, wired.safeAddress).catch(() => [])
    result = {
      ...wired,
      roleKey: state.roleKey,
      safeOwner: owners.join(', ') || '(your Safe owner)',
    }
  } else {
    result = await deploySafeAndRoles({
      publicClient,
      walletClient,
      botAddress: botAccount.address,
      poolAddress: state.poolAddress,
      roleKey: state.roleKey,
      addresses,
      saltNonce: BigInt(state.saltNonce),
      extraRoles: toExtraRoleSpecs(state),
      finalSafeOwner: state.finalSafeOwner,
      known: { safeAddress: state.safeAddress, rolesModifierAddress: state.rolesModifierAddress },
      // Persist each address as it lands so a later failure resumes cleanly.
      onDeployed: async (partial) => {
        Object.assign(state, partial)
        await writeState(state)
      },
    })
  }

  // ---- Verify the security boundary ----------------------------------------
  console.log('\n Verifying loan-only scope on-chain (runbook Step 0)…')
  await verifyLoanOnlyScope({
    publicClient: publicClient as PublicClient,
    rolesModifierAddress: result.rolesModifierAddress,
    botAddress: botAccount.address,
    roleKey: state.roleKey,
    poolAddress: state.poolAddress,
    poolId,
  })

  const deleveragerSpec = state.extraRoles.find((r) => r.kind === 'deleverager')
  if (deleveragerSpec) {
    console.log(' Verifying deleverager burn-only scope on-chain…')
    await verifyDeleveragerScope({
      publicClient: publicClient as PublicClient,
      rolesModifierAddress: result.rolesModifierAddress,
      botAddress: deleveragerSpec.member,
      roleKey: DELEVERAGER_ROLE_KEY,
      poolAddress: state.poolAddress,
      poolId,
    })
  }

  // ---- Write .env, then drop the resume state ------------------------------
  const values: EnvValues = {
    CHAIN_ID: state.chainId,
    RPC_URL: state.rpcUrl,
    POOL_ADDRESS: state.poolAddress,
    SAFE_ADDRESS: result.safeAddress,
    ROLES_MODIFIER_ADDRESS: result.rolesModifierAddress,
    ROLE_KEY: result.roleKey,
    BOT_PRIVATE_KEY: state.storage === 'plaintext' ? botKey : undefined,
    BOT_KEYSTORE_PATH: state.storage === 'keystore' ? keystorePath : undefined,
    ASSET_INDEX: state.assetIndex,
    DELTA_THRESHOLD_BPS: state.deltaThresholdBps,
    DELTA_OFFSET_BPS: state.deltaOffset,
    PRICE_SIGNAL_SOURCE: 'pool-tick',
    HEDGE_VENUE: 'in-pool',
    DRY_RUN: state.dryRun,
    UNISWAP_LP_OWNER: state.uniswapLpOwner,
    HEDGE_INCLUDE_LP: state.hedgeIncludeLp,
    DELEVERAGER_ENABLED: deleveragerSpec ? true : undefined,
  }
  const body = renderEnvFile(values)

  // Re-validate before writing, so a schema mismatch surfaces now.
  parseHedgerBotConfig(dotenvObject(body))

  writeSecureText(envPath, body)
  console.log(`✓ Wrote ${envPath}`)

  // Success: the .env is the source of truth now — remove the resume state.
  // If cleanup fails, warn loudly: the state file may still hold the plaintext
  // bot private key on disk.
  try {
    removeSecureFile(STATE_PATH)
  } catch (err) {
    console.warn(
      `  ⚠️  Could not remove resume state ${STATE_PATH}: ${sanitizeError(err)}\n` +
        `      It contains sensitive deployment metadata — remove it with onboard cleanup.`,
    )
  }
  if (state.storage === 'plaintext') {
    try {
      removeSecureFile(KEYSTORE_PATH)
    } catch (err) {
      console.warn(
        `  ⚠️  Could not remove temporary recovery keystore ${KEYSTORE_PATH}: ` +
          sanitizeError(err),
      )
    }
  }

  console.log(
    '\n🎉 Setup complete — your loan-only hedger Safe is deployed, scoped, and verified. ✅',
  )

  const txs: [string, `0x${string}` | undefined][] = [
    ['Safe deploy', result.safeTxHash],
    ['Roles modifier deploy', result.rolesTxHash],
    ['Configure (enable module + loan-only scope + ownership hand-off)', result.configureTxHash],
  ]
  const landedTxs = txs.filter((entry): entry is [string, `0x${string}`] => Boolean(entry[1]))
  if (landedTxs.length > 0) {
    console.log('\n  📝 Transactions:')
    for (const [label, hash] of landedTxs) {
      console.log(`     ✅ ${label}\n        ${hash}`)
    }
  }

  console.log('\nNext steps:')
  console.log(`  Safe ${result.safeAddress} is owned by ${result.safeOwner}.`)
  console.log(
    `  1. (optional) Monitor this Safe on Telegram — open @panopticMonitorBot\n` +
      `     (https://t.me/panopticMonitorBot) and send:  /monitor ${result.safeAddress}\n` +
      `     You'll get alerts on the Safe's on-chain activity, plus /positions and /greeks.\n` +
      `     Read-only; no bot token or .env change needed.`,
  )
  console.log(`  2. Keep the bot EOA (${botAccount.address}) topped up with gas.`)
  console.log(
    `  3. As the Safe owner (${result.safeOwner}), buy options into the Safe + deposit collateral.`,
  )
  console.log('  4. pnpm preflight          # read-only release checks')
  console.log('  5. pnpm inspect:hedge      # dry-run one cycle')
  console.log('  6. DRY_RUN=true pnpm start # full loop, simulated')
  console.log('  7. pnpm activate           # bind approval to policy + artifact')
  console.log('  8. pnpm start              # live only after activation')
  console.log('  9. pnpm status && pnpm health')
  if (state.uniswapLpOwner || state.hedgeIncludeLp) {
    console.log(
      '\n  Uniswap LP hedging is configured. In `pnpm inspect:hedge`, check the\n' +
        '  `lpDelta` line: confirm the position count + delta match your real LP\n' +
        '  exposure and that the subgraph is fresh (not stale).' +
        (state.hedgeIncludeLp
          ? ''
          : '\n  It is OBSERVE-ONLY now; set HEDGE_INCLUDE_LP=true to fold it into the hedge.'),
    )
  }
  if (state.storage === 'keystore') {
    console.log(
      '\n  The bot key is stored encrypted; you will be prompted for the keystore\n' +
        '  passphrase at startup. For unattended restarts, prefer the owner-only\n' +
        '  BOT_KEYSTORE_PASSPHRASE_FILE secret.',
    )
  }

  // Opt-in: help the operator pick a first position now that the Safe is live.
  try {
    if (await prompter.confirm('\nNeed help choosing your first position?', false)) {
      const deployment = getChainDeployment(state.chainId)
      const subgraphUrl = deployment?.subgraphs.panoptic
      const queryAddress = deployment?.panoptic.v2.panopticQuery
      if (!subgraphUrl || !queryAddress) {
        console.log(`  (skipped: no Panoptic subgraph/query address for chain ${state.chainId})`)
      } else {
        await runGenerateIdea(prompter, {
          client: publicClient as PublicClient,
          chainId: state.chainId,
          poolAddress: state.poolAddress,
          safeAddress: result.safeAddress,
          assetIndex: BigInt(state.assetIndex),
          subgraphUrl,
          queryAddress,
        })
      }
    }
  } catch (err) {
    // Idea generation is a convenience — never let it fail a completed setup.
    console.warn(`  ⚠️  Could not generate a first-position idea: ${sanitizeError(err)}`)
  }
}

/** Parse a rendered .env body into a plain object for config validation. */
function dotenvObject(body: string): NodeJS.ProcessEnv {
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

// Only run the wizard when invoked directly (matches generateIdea.ts /
// checkWsVersion.ts) so importing this module for its exports — e.g. the state
// schema in tests — does not kick off an interactive deployment.
const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((err) => {
    console.error(sanitizeError(err))
    process.exit(1)
  })
}
