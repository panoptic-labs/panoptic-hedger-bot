import { getPool, getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { formatEther } from 'viem'

import { deleveragerRoleKey } from '../../../src/config'
import { validateBotToken } from '../../../src/notify/telegramOnboard'
import { createPriceSignalSource, PriceSignalUnavailableError } from '../../../src/priceSignal'
import { rolesModifierV2Abi } from '../../../src/safe/rolesAbi'
import {
  isProductionEligibleConfig,
  productionProfileViolations,
} from '../../../src/security/productionProfile'
import { sanitizeError } from '../../../src/utils/sanitize'
import { asSdkClient } from '../../../src/utils/sdkClient'
import { verifyExactAuthorizationManifest } from '../authorizationManifest'
import { isModuleEnabled, readSafeOwners } from '../existingSafe'
import {
  findContractDeploymentBlock,
  getSafeZodiacAddresses,
  verifySafeAndRolesProxyIdentities,
} from '../safeZodiacRegistry'
import { hasCode } from '../txWait'
import { verifyDeleveragerScope, verifyLoanOnlyScope } from '../verifyScope'
import type { DiagnosticsContext } from './context'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export interface DoctorResult {
  id: string
  title: string
  status: CheckStatus
  detail: string
  remedy?: string
}

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'FRAX', 'LUSD', 'GUSD'])

/** Which pool token is ETH (non-stable side), or undefined if ambiguous. */
function deriveEthTokenIndex(token0Symbol: string, token1Symbol: string): 0n | 1n | undefined {
  const s0 = STABLES.has(token0Symbol.toUpperCase())
  const s1 = STABLES.has(token1Symbol.toUpperCase())
  if (s0 && !s1) return 1n
  if (s1 && !s0) return 0n
  return undefined // both or neither stable — can't orient a USD price
}

/**
 * Run the read-only preflight. Never sends a state-changing transaction (the
 * optional Telegram test is the only outbound message, gated by `sendTelegram`).
 * Each check is independent; a thrown error becomes a `fail` with its message.
 */
export async function runDoctorChecks(
  ctx: DiagnosticsContext,
  opts: { sendTelegram?: boolean } = {},
): Promise<DoctorResult[]> {
  const { config, publicClient, botAddress, addressError, account, accountError } = ctx
  const results: DoctorResult[] = []
  const push = (r: DoctorResult) => results.push(r)

  // 1. RPC reachable + chain id matches.
  let chainOk = false
  try {
    const rpcChainId = await publicClient.getChainId()
    if (rpcChainId === config.CHAIN_ID) {
      chainOk = true
      push({
        id: 'rpc',
        title: 'RPC connectivity + chain id',
        status: 'pass',
        detail: `chain ${rpcChainId}`,
      })
    } else {
      push({
        id: 'rpc',
        title: 'RPC connectivity + chain id',
        status: 'fail',
        detail: `RPC reports chain ${rpcChainId}, config says ${config.CHAIN_ID}`,
        remedy: 'Point RPC_URL at the right network or fix CHAIN_ID.',
      })
    }
  } catch (err) {
    push({
      id: 'rpc',
      title: 'RPC connectivity + chain id',
      status: 'fail',
      detail: msg(err),
      remedy: 'Check RPC_URL is reachable and valid.',
    })
  }

  // 2. Bot key / keystore access. A locked keystore (address readable, but no
  // passphrase provided to decrypt) is a WARNING, not a failure — the address is
  // enough for every read-only check, and the bot will prompt for the passphrase
  // at start. A genuinely unreadable key source (or a wrong passphrase) fails.
  const keystoreLocked =
    !account &&
    !!botAddress &&
    !!config.BOT_KEYSTORE_PATH &&
    config.BOT_KEYSTORE_PASSPHRASE === undefined
  push(
    account
      ? {
          id: 'key',
          title: 'Bot key / keystore access',
          status: 'pass',
          detail: `bot ${account.address}`,
        }
      : keystoreLocked
        ? {
            id: 'key',
            title: 'Bot key / keystore access',
            status: 'warn',
            detail: `keystore locked for bot ${botAddress} (BOT_KEYSTORE_PASSPHRASE not set)`,
            remedy:
              'Set BOT_KEYSTORE_PASSPHRASE to verify the key here and start unattended; otherwise the bot prompts at start.',
          }
        : {
            id: 'key',
            title: 'Bot key / keystore access',
            status: 'fail',
            detail: msg(accountError ?? addressError),
            remedy: 'Check BOT_PRIVATE_KEY, or BOT_KEYSTORE_PATH + passphrase.',
          },
  )

  if (!chainOk) {
    push(skip('contracts', 'On-chain checks', 'RPC/chain check failed'))
    return results
  }

  const supportedProfile = isProductionEligibleConfig(config)
  push({
    id: 'production-profile',
    title: 'Production eligibility profile',
    status: supportedProfile ? 'pass' : 'fail',
    detail: supportedProfile
      ? 'Ethereum mainnet, in-pool hedge venue, supported signal'
      : productionProfileViolations(config).join('; '),
    remedy: supportedProfile
      ? undefined
      : 'Use the supported mainnet in-pool profile; experimental profiles cannot activate.',
  })

  // 3. Contract bytecode present for pool / safe / modifier.
  const codeChecks = await Promise.all(
    (
      [
        ['pool', 'PanopticPool', config.POOL_ADDRESS],
        ['safe', 'Safe', config.SAFE_ADDRESS],
        ['modifier', 'Roles modifier', config.ROLES_MODIFIER_ADDRESS],
      ] as const
    ).map(async ([id, label, addr]): Promise<DoctorResult> => {
      try {
        return (await hasCode(publicClient, addr))
          ? { id: `code-${id}`, title: `${label} bytecode`, status: 'pass', detail: addr }
          : {
              id: `code-${id}`,
              title: `${label} bytecode`,
              status: 'fail',
              detail: `no code at ${addr}`,
              remedy: `Check ${label} address / chain.`,
            }
      } catch (err) {
        return { id: `code-${id}`, title: `${label} bytecode`, status: 'fail', detail: msg(err) }
      }
    }),
  )
  codeChecks.forEach(push)

  try {
    const addresses = getSafeZodiacAddresses(config.CHAIN_ID)
    await verifySafeAndRolesProxyIdentities(
      publicClient,
      addresses,
      config.SAFE_ADDRESS,
      config.ROLES_MODIFIER_ADDRESS,
    )
    push({
      id: 'contract-identities',
      title: 'Safe/Zodiac code identities',
      status: 'pass',
      detail: 'canonical factories, implementations, and proxy provenance verified',
    })
  } catch (err) {
    push({
      id: 'contract-identities',
      title: 'Safe/Zodiac code identities',
      status: 'fail',
      detail: msg(err),
      remedy: 'Use the reviewed canonical mainnet Safe/Zodiac deployments.',
    })
  }

  // 4. Safe owners — the bot must NOT be one (least privilege).
  try {
    const owners = await readSafeOwners(publicClient, config.SAFE_ADDRESS)
    const botIsOwner =
      botAddress && owners.some((o) => o.toLowerCase() === botAddress.toLowerCase())
    push({
      id: 'owners',
      title: 'Safe ownership',
      status: botIsOwner ? 'fail' : 'pass',
      detail: `owners: ${owners.join(', ')}`,
      remedy: botIsOwner
        ? 'The bot EOA is a Safe owner — it should only hold a scoped role.'
        : undefined,
    })
  } catch (err) {
    push({
      id: 'owners',
      title: 'Safe ownership',
      status: 'fail',
      detail: msg(err),
      remedy: 'Is SAFE_ADDRESS a Safe?',
    })
  }

  // 5. Module enabled on the Safe.
  try {
    const enabled = await isModuleEnabled(
      publicClient,
      config.SAFE_ADDRESS,
      config.ROLES_MODIFIER_ADDRESS,
    )
    push(
      enabled
        ? {
            id: 'module',
            title: 'Roles module enabled',
            status: 'pass',
            detail: 'enabled on the Safe',
          }
        : {
            id: 'module',
            title: 'Roles module enabled',
            status: 'fail',
            detail: 'module not enabled on the Safe',
            remedy: 'Enable the Roles modifier on the Safe (see onboard/runbook).',
          },
    )
  } catch (err) {
    push({ id: 'module', title: 'Roles module enabled', status: 'fail', detail: msg(err) })
  }

  // 6. Modifier wiring: avatar == target == owner == Safe.
  try {
    const [avatar, target, owner] = (await Promise.all(
      (['avatar', 'target', 'owner'] as const).map((fn) =>
        publicClient.readContract({
          address: config.ROLES_MODIFIER_ADDRESS,
          abi: rolesModifierV2Abi,
          functionName: fn,
        }),
      ),
    )) as [`0x${string}`, `0x${string}`, `0x${string}`]
    const wired = [avatar, target, owner].every(
      (a) => a.toLowerCase() === config.SAFE_ADDRESS.toLowerCase(),
    )
    push({
      id: 'wiring',
      title: 'Modifier wiring (avatar/target/owner = Safe)',
      status: wired ? 'pass' : 'fail',
      detail: wired ? 'all point to the Safe' : `avatar=${avatar} target=${target} owner=${owner}`,
      remedy: wired
        ? undefined
        : 'Re-deploy/re-scope the modifier so avatar/target/owner are the Safe.',
    })
  } catch (err) {
    push({ id: 'wiring', title: 'Modifier wiring', status: 'fail', detail: msg(err) })
  }

  // Pool metadata (needed for scope + signal + orientation checks).
  let poolId: bigint | undefined
  let token0Symbol = ''
  let token1Symbol = ''
  let token0Decimals = 0n
  let token1Decimals = 0n
  try {
    const md = await getPoolMetadata({
      client: asSdkClient<typeof getPoolMetadata>(publicClient),
      poolAddress: config.POOL_ADDRESS,
    })
    poolId = md.poolId
    token0Symbol = md.token0Symbol
    token1Symbol = md.token1Symbol
    token0Decimals = BigInt(md.token0Decimals)
    token1Decimals = BigInt(md.token1Decimals)
  } catch (err) {
    push({ id: 'metadata', title: 'Pool metadata', status: 'fail', detail: msg(err) })
  }

  // 7. Loan-only scope (loan allowed, options blocked).
  if (poolId !== undefined && botAddress) {
    try {
      await verifyLoanOnlyScope({
        publicClient,
        rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
        botAddress,
        roleKey: config.ROLE_KEY,
        poolAddress: config.POOL_ADDRESS,
        poolId,
        log: () => {},
      })
      push({
        id: 'scope',
        title: 'Loan-only scope',
        status: 'pass',
        detail: 'loan allowed, options blocked',
      })
    } catch (err) {
      push({
        id: 'scope',
        title: 'Loan-only scope',
        status: 'fail',
        detail: msg(err),
        remedy: 'Re-run onboard/scope so the bot role is scoped loan-only to this pool.',
      })
    }
  } else {
    push(skip('scope', 'Loan-only scope', 'pool metadata or bot key unavailable'))
  }

  // 7b. Deleverager scope (only when enabled): zero sizes pass, non-zero blocked.
  // A failure here BLOCKS activation — an enabled deleverager whose burn-only
  // boundary cannot be proven on-chain must not go live.
  if (config.DELEVERAGER_ENABLED) {
    if (poolId !== undefined && botAddress) {
      try {
        await verifyDeleveragerScope({
          publicClient,
          rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
          botAddress,
          roleKey: deleveragerRoleKey(config),
          poolAddress: config.POOL_ADDRESS,
          poolId,
          log: () => {},
        })
        push({
          id: 'deleverager-scope',
          title: 'Deleverager burn-only scope',
          status: 'pass',
          detail: 'zero sizes allowed, non-zero sizes blocked',
        })
      } catch (err) {
        push({
          id: 'deleverager-scope',
          title: 'Deleverager burn-only scope',
          status: 'fail',
          detail: msg(err),
          remedy:
            'Provision the burn-only deleverager role for the bot EOA (pnpm manage-role, ROLE=deleverager ACTION=provision) or set DELEVERAGER_ENABLED=false.',
        })
      }
    } else {
      push(
        skip(
          'deleverager-scope',
          'Deleverager burn-only scope',
          'pool metadata or bot key unavailable',
        ),
      )
    }
  }

  if (botAddress && supportedProfile) {
    try {
      await verifyExactAuthorizationManifest({
        publicClient,
        rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
        botAddress,
        roleKey: config.ROLE_KEY,
        poolAddress: config.POOL_ADDRESS,
        deploymentBlock: await findContractDeploymentBlock(
          publicClient,
          config.ROLES_MODIFIER_ADDRESS,
        ),
        deleverager: config.DELEVERAGER_ENABLED
          ? { member: botAddress, roleKey: deleveragerRoleKey(config) }
          : undefined,
      })
      push({
        id: 'permission-manifest',
        title: 'Complete Roles permission manifest',
        status: 'pass',
        detail: config.DELEVERAGER_ENABLED
          ? 'exactly one member with the reviewed loan-only + burn-only deleverager function scopes'
          : 'exactly one member, role, pool target, and reviewed loan-only function scope',
      })
    } catch (err) {
      push({
        id: 'permission-manifest',
        title: 'Complete Roles permission manifest',
        status: 'warn',
        detail: msg(err),
        remedy:
          'Review stale permissions; re-onboard with a fresh modifier/role for the exact manifest.',
      })
    }
  } else {
    push(
      skip(
        'permission-manifest',
        'Complete Roles permission manifest',
        'unsupported profile or bot address unavailable',
      ),
    )
  }

  // 8. Token orientation (which side is ETH vs stable).
  if (token0Symbol) {
    const eth = deriveEthTokenIndex(token0Symbol, token1Symbol)
    const assetSym = config.ASSET_INDEX === 0n ? token0Symbol : token1Symbol
    push({
      id: 'orientation',
      title: 'Token orientation',
      status: eth === undefined ? 'warn' : 'pass',
      detail:
        `pool ${token0Symbol}/${token1Symbol}; ASSET_INDEX=${config.ASSET_INDEX} (${assetSym})` +
        (eth === undefined ? '' : `; ETH side = token${eth}`),
      remedy:
        eth === undefined
          ? 'Neither/both tokens look like a stable — the CEX signal cannot orient the USD price here (pool-tick still works).'
          : undefined,
    })
  }

  // 9. Price signal freshness + sanity vs pool tick.
  if (token0Symbol) {
    const eth = deriveEthTokenIndex(token0Symbol, token1Symbol)
    let source
    try {
      source = createPriceSignalSource(config, {
        publicClient,
        token0Decimals,
        token1Decimals,
        ethTokenIndex: eth,
      })
      const signal = await source.getSignal()
      const pool = await getPool({
        client: asSdkClient<typeof getPool>(publicClient),
        poolAddress: config.POOL_ADDRESS,
        chainId: BigInt(config.CHAIN_ID),
      })
      const gap =
        signal.tick > pool.currentTick
          ? signal.tick - pool.currentTick
          : pool.currentTick - signal.tick
      const ageS = Math.round((Date.now() - signal.observedAtMs) / 1000)
      const withinSanity = gap <= BigInt(config.SIGNAL_TICK_SANITY_MAX)
      push({
        id: 'signal',
        title: 'Price signal',
        status: withinSanity ? 'pass' : 'fail',
        detail: `source=${signal.source} tick=${signal.tick} poolTick=${pool.currentTick} gap=${gap} age=${ageS}s`,
        remedy: withinSanity
          ? undefined
          : `Signal/pool tick gap ${gap} > SIGNAL_TICK_SANITY_MAX ${config.SIGNAL_TICK_SANITY_MAX} — check ASSET_INDEX/pairing.`,
      })
    } catch (err) {
      const warmup = err instanceof PriceSignalUnavailableError
      push({
        id: 'signal',
        title: 'Price signal',
        status: warmup ? 'warn' : 'fail',
        detail: msg(err),
        remedy: warmup ? 'Feeds may still be warming up; re-run in a few seconds.' : undefined,
      })
    } finally {
      source?.stop?.()
    }
  }

  // 10. Keeper gas balance.
  if (botAddress) {
    try {
      const bal = await publicClient.getBalance({ address: botAddress })
      const warn = config.KEEPER_BALANCE_WARN_ETH
      push({
        id: 'gas',
        title: 'Keeper gas balance',
        status: bal === 0n ? 'fail' : bal < warn ? 'warn' : 'pass',
        detail: `${formatEther(bal)} ETH (warn < ${formatEther(config.KEEPER_BALANCE_WARN_ETH)})`,
        remedy: bal < warn ? `Top up the bot ${botAddress} with ETH for gas.` : undefined,
      })
    } catch (err) {
      push({ id: 'gas', title: 'Keeper gas balance', status: 'fail', detail: msg(err) })
    }
  }

  // 11. Telegram delivery (optional).
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    try {
      const username = await validateBotToken(config.TELEGRAM_BOT_TOKEN)
      let detail = `token valid (@${username})`
      if (opts.sendTelegram) {
        const { sendTelegramTest } = await import('../../../src/notify/telegramOnboard')
        const sent = await sendTelegramTest(
          config.TELEGRAM_BOT_TOKEN,
          config.TELEGRAM_CHAT_ID,
          '✅ hedger-bot doctor test',
        )
        detail += sent ? ' — test message sent' : ' — test message FAILED to send'
      }
      push({ id: 'telegram', title: 'Telegram delivery', status: 'pass', detail })
    } catch (err) {
      push({
        id: 'telegram',
        title: 'Telegram delivery',
        status: 'warn',
        detail: msg(err),
        remedy: 'Check TELEGRAM_BOT_TOKEN/CHAT_ID.',
      })
    }
  }

  // 12. Experimental-feature warning (narrowed v1).
  if (config.PRICE_SIGNAL_SOURCE === 'uniswap-pool') {
    push({
      id: 'experimental',
      title: 'Experimental features',
      status: 'warn',
      detail: 'PRICE_SIGNAL_SOURCE=uniswap-pool',
      remedy:
        'These are not covered by v1 support — their setup/monitoring/recovery are not as hardened as the core.',
    })
  }

  return results
}

function skip(id: string, title: string, reason: string): DoctorResult {
  return { id, title, status: 'skip', detail: `skipped: ${reason}` }
}

function msg(err: unknown): string {
  return sanitizeError(err)
}
