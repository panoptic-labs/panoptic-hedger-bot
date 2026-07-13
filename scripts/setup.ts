import 'dotenv/config'

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getChainDeployment, getPoolMetadata, isSupportedChain } from '@panoptic-eng/sdk/v2'
import { type PublicClient, createPublicClient, createWalletClient, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { parseHedgerBotConfig } from '../src/config'
import { defineBotChain } from '../src/utils/chain'
import { deriveBotPrivateKey } from '../src/utils/entropy'
import { type KeystoreV3, encryptKeystore } from '../src/utils/keystore'
import { asSdkClient } from '../src/utils/sdkClient'
import {
  type ExtraRoleKind,
  type ExtraRoleSpec,
  buildSafeSetupInitializer,
  deploySafeAndRoles,
} from './lib/deployCore'
import { configureExistingSafe, readSafeOwners } from './lib/existingSafe'
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
import { verifyLoanOnlyScope } from './lib/verifyScope'

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
  dryRun: boolean
  storage: 'keystore' | 'plaintext'
  /** Only set for plaintext storage — keystore mode keeps the key in the file. */
  botPrivateKey?: `0x${string}`
  telegramToken?: string
  telegramChat?: string
  extraRoles: { kind: ExtraRoleKind; member: `0x${string}`; sizeCap?: string }[]
  /** Filled in by onDeployed as each contract lands, for a clean resume. */
  safeAddress?: `0x${string}`
  rolesModifierAddress?: `0x${string}`
}

async function writeState(state: DeployState): Promise<void> {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

async function readState(): Promise<DeployState> {
  return JSON.parse(await readFile(STATE_PATH, 'utf8')) as DeployState
}

function toExtraRoleSpecs(state: DeployState): ExtraRoleSpec[] {
  return state.extraRoles.map((r) => ({
    kind: r.kind,
    member: r.member,
    sizeCap: r.sizeCap === undefined ? undefined : BigInt(r.sizeCap),
  }))
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
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
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
    const supportedChains = Object.keys(SAFE_ZODIAC_ADDRESSES)
      .map(Number)
      .filter((id) => isSupportedChain(id))
    const chainChoices = [
      ...supportedChains.map((id) => ({ label: `chain ${id}`, value: String(id) })),
      { label: 'other (manual — requires Safe/Zodiac env overrides)', value: 'other' },
    ]
    let chainId: number
    const picked = await p.choice('Target chain:', chainChoices, chainChoices[0]?.value as string)
    if (picked === 'other') {
      chainId = Number(
        await p.text('CHAIN_ID', {
          validate: (v) =>
            Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'positive integer',
        }),
      )
    } else {
      chainId = Number(picked)
    }

    const rpcUrl = await p.text('RPC_URL', { validate: validateUrl })
    const poolAddress = (await p.text('POOL_ADDRESS (PanopticPool)', {
      validate: validateAddress,
    })) as `0x${string}`

    // Two ways to get a scoped Safe: let the bot deploy a fresh one, or wire onto
    // a Safe the user already controls (add a new pool to an existing hedger, or
    // bring a clean self-generated Safe).
    const safeMode = (await p.choice(
      'Safe setup:',
      [
        { label: 'Deploy a new Safe (recommended)', value: 'new' },
        { label: 'Use an existing Safe I control', value: 'existing' },
      ],
      'new',
    )) as 'new' | 'existing'

    // 'new': the Safe owner — your own wallet (hardware / browser). It controls
    // the Safe (burn positions, withdraw funds, re-scope roles); it is NOT the
    // bot and never pastes a private key here. The bot deploys everything and
    // hands ownership to this address.
    // 'existing': you already own the Safe; the bot only deploys the Roles
    // modifier (if needed) and you authorize the enable/scope calls in the Safe UI.
    let finalSafeOwner: `0x${string}` | undefined
    let existingSafeAddress: `0x${string}` | undefined
    let existingRolesModifier: `0x${string}` | undefined
    let existingRoleKey: `0x${string}` | undefined
    if (safeMode === 'new') {
      finalSafeOwner = (await p.text(
        'Safe owner address (Ledger / MetaMask / Rabby — controls the Safe, NOT the bot)',
        { validate: validateAddress },
      )) as `0x${string}`
    } else {
      existingSafeAddress = (await p.text('SAFE_ADDRESS (a Safe you already control)', {
        validate: validateAddress,
      })) as `0x${string}`
      const rm = await p.text('ROLES_MODIFIER_ADDRESS (leave blank to deploy a new one)', {
        default: '',
        validate: (v) =>
          v === '' || /^0x[a-fA-F0-9]{40}$/.test(v) ? undefined : 'a 20-byte hex address, or blank',
      })
      existingRolesModifier = rm === '' ? undefined : (rm as `0x${string}`)
      if (existingRolesModifier) {
        // Add-pool onto an existing modifier reuses the bot's existing role.
        existingRoleKey = (await p.text('ROLE_KEY (the bot role on that modifier, 0x… 32 bytes)', {
          validate: (v) => (/^0x[a-fA-F0-9]{64}$/.test(v) ? undefined : 'a 32-byte hex role key'),
        })) as `0x${string}`
      }
    }

    const botMode = await p.choice(
      'Bot signer key:',
      [
        { label: 'generate a new key', value: 'generate' },
        { label: 'import an existing key', value: 'import' },
      ],
      'generate',
    )
    let botKey: `0x${string}`
    if (botMode === 'import') {
      botKey = (await p.secret('BOT_PRIVATE_KEY', validatePrivateKey)) as `0x${string}`
    } else {
      // The key comes from the OS CSPRNG (randomBytes) — already sufficient on
      // its own. Advanced users can optionally fold in their own entropy; it is
      // mixed in (keccak256) so it can only add to, never weaken, the system RNG.
      let userEntropy = ''
      if (await p.confirm('Add your own extra entropy? (optional, advanced)', false)) {
        userEntropy = await p.secret('Extra entropy (any text)')
      }
      botKey = deriveBotPrivateKey(userEntropy, randomBytes(32))
    }
    const botAccount = privateKeyToAccount(botKey)
    console.log(
      `  → Bot EOA is ${botAccount.address} (deploys, then runs hedging — fund it with gas)`,
    )

    // How to persist the bot key. Encrypted keystore keeps no plaintext at rest.
    const botStorage = (await p.choice(
      'Store the bot key as:',
      [
        { label: 'passphrase-encrypted keystore file (recommended)', value: 'keystore' },
        { label: 'plaintext in .env', value: 'plaintext' },
      ],
      'keystore',
    )) as 'keystore' | 'plaintext'
    let keystorePassphrase: string | undefined
    if (botStorage === 'keystore') {
      for (;;) {
        const pass = await p.secret('Keystore passphrase (min 12 chars)', (v) =>
          v.length >= 12 ? undefined : 'at least 12 characters',
        )
        const confirm = await p.secret('Confirm passphrase')
        if (pass !== confirm) {
          console.log('  ✗ passphrases do not match — try again')
          continue
        }
        keystorePassphrase = pass
        break
      }
      console.log('  ⚠️  If you lose this passphrase the bot key is unrecoverable.')
    }

    const deltaThresholdBps = Number(
      await p.text('DELTA_THRESHOLD_BPS (rehedge trigger)', { default: '200' }),
    )
    const dryRun = await p.confirm('Start in DRY_RUN (simulate, send nothing)?', true)
    // Telegram alerts are optional and configured out-of-band: set TELEGRAM_BOT_TOKEN
    // and TELEGRAM_CHAT_ID in .env after onboarding (see README). The wizard no
    // longer walks through BotFather so it stays focused on the on-chain setup.
    const telegramToken: string | undefined = undefined
    const telegramChat: string | undefined = undefined

    // The onboard wizard deploys a strictly loan-only bot (minimal privilege).
    // The à-la-carte keeper roles (deleverager / maintenance / roller /
    // size-adjuster) have no consumer in this bot's runtime, so they are not
    // offered here. Advanced operators can still scope them onto an existing
    // modifier later with `pnpm manage-role` (see README).
    const extraRoles: ExtraRoleSpec[] = []

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
      throw new Error(`RPC unreachable at ${rpcUrl}: ${e instanceof Error ? e.message : String(e)}`)
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
          (e instanceof Error ? e.message : String(e)),
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

    const addresses = getSafeZodiacAddresses(chainId)
    await verifySafeZodiacBytecode(publicClient, addresses)
    console.log('  → Safe/Zodiac infrastructure verified on-chain.')

    // Existing-Safe: confirm the address is actually a Safe and show its owners
    // (the bot must NOT be one — it only ever gets a scoped role).
    if (safeMode === 'existing' && existingSafeAddress) {
      const owners = await readSafeOwners(publicClient, existingSafeAddress).catch((e) => {
        throw new Error(
          `${existingSafeAddress} does not look like a Safe (getOwners failed): ` +
            (e instanceof Error ? e.message : String(e)),
        )
      })
      console.log(`  → Safe owners: ${owners.join(', ')}`)
      if (owners.some((o) => o.toLowerCase() === botAccount.address.toLowerCase())) {
        console.log(
          '  ⚠️  the bot EOA is a Safe owner — for least privilege it should only hold a role.',
        )
      }
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
    if (!(await p.confirm('\n Proceed?', false))) {
      console.log('Aborted. Nothing was deployed.')
      p.close()
      return
    }

    // Persist the bot key + resume state BEFORE asking for funds. From here on a
    // crash can never strand ETH at an unrecoverable address.
    let botPrivateKey: `0x${string}` | undefined
    let botKeystorePath: string | undefined
    if (botStorage === 'keystore' && keystorePassphrase) {
      const keystore = encryptKeystore(botKey, keystorePassphrase)
      await writeFile(KEYSTORE_PATH, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600 })
      botKeystorePath = './bot-keystore.json'
      console.log(`✓ Wrote encrypted keystore ${KEYSTORE_PATH}`)
    } else {
      botPrivateKey = botKey
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
      dryRun,
      storage: botStorage,
      botPrivateKey,
      telegramToken,
      telegramChat,
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

  // Reconstruct the bot key: from the encrypted keystore (prompt passphrase) or
  // from the saved plaintext key.
  let botKey: `0x${string}`
  let keystorePath: string | undefined
  if (state.storage === 'keystore') {
    if (!existsSync(KEYSTORE_PATH)) {
      throw new Error(`keystore ${KEYSTORE_PATH} missing — cannot resume`)
    }
    const { decryptKeystore } = await import('../src/utils/keystore')
    const keystore = JSON.parse(await readFile(KEYSTORE_PATH, 'utf8')) as KeystoreV3
    for (;;) {
      const pass = await p.secret('Keystore passphrase')
      try {
        botKey = decryptKeystore(keystore, pass)
        break
      } catch {
        console.log('  ✗ wrong passphrase — try again')
      }
    }
    keystorePath = './bot-keystore.json'
  } else {
    if (!state.botPrivateKey) throw new Error('resume state missing plaintext key')
    botKey = state.botPrivateKey
  }
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
    PRICE_SIGNAL_SOURCE: 'pool-tick',
    HEDGE_VENUE: 'in-pool',
    DRY_RUN: state.dryRun,
    TELEGRAM_BOT_TOKEN: state.telegramToken,
    TELEGRAM_CHAT_ID: state.telegramChat,
  }
  const body = renderEnvFile(values)

  // Re-validate before writing, so a schema mismatch surfaces now.
  parseHedgerBotConfig(dotenvObject(body))

  await writeFile(envPath, body, { mode: 0o600 })
  console.log(`✓ Wrote ${envPath}`)

  // Success: the .env is the source of truth now — remove the resume state.
  // If cleanup fails, warn loudly: the state file may still hold the plaintext
  // bot private key on disk.
  await unlink(STATE_PATH).catch((err) => {
    console.warn(
      `  ⚠️  Could not remove resume state ${STATE_PATH}: ${err instanceof Error ? err.message : String(err)}\n` +
        `      It may still contain the plaintext bot private key — delete it manually.`,
    )
  })

  console.log('\nNext steps:')
  console.log(`  Safe ${result.safeAddress} is owned by ${result.safeOwner}.`)
  console.log(`  1. Keep the bot EOA (${botAccount.address}) topped up with gas.`)
  console.log(
    `  2. As the Safe owner (${result.safeOwner}), buy options into the Safe + deposit collateral.`,
  )
  console.log('  3. pnpm inspect:hedge      # dry-run one cycle')
  console.log('  4. DRY_RUN=true pnpm start  # full loop, simulated')
  console.log('  5. pnpm start               # live')
  if (state.storage === 'keystore') {
    console.log(
      '\n  The bot key is stored encrypted; you will be prompted for the keystore\n' +
        '  passphrase at startup. For unattended restarts, set BOT_KEYSTORE_PASSPHRASE.',
    )
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
