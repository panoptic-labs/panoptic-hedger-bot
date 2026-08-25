import { getPool, getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { CANONICAL_ADAPTERS } from '@panoptic-eng/sdk/zodiac'
import type { Address } from 'viem'
import { formatEther, zeroAddress } from 'viem'

import { deleveragerRoleKey, walletWethAddress } from '../../../src/config'
import { readSafeLpPositions } from '../../../src/hedge/lpPositions'
import { validateBotToken } from '../../../src/notify/telegramOnboard'
import {
  createPriceSignalSource,
  PriceSignalUnavailableError,
  waitForPriceSignal,
} from '../../../src/priceSignal'
import { assertSafeCanReceiveErc1155 } from '../../../src/safe/erc1155Receiver'
import { rolesModifierV2Abi } from '../../../src/safe/rolesAbi'
import {
  isProductionEligibleConfig,
  productionProfileViolations,
} from '../../../src/security/productionProfile'
import { sanitizeError } from '../../../src/utils/sanitize'
import { asSdkClient } from '../../../src/utils/sdkClient'
import {
  formatAuthorizationManifestDiff,
  inspectExactAuthorizationManifest,
} from '../authorizationManifest'
import type { SfpmSwapConfigureInput } from '../deployCore'
import { isModuleEnabled, readSafeOwners, verifySfpmSwapReady } from '../existingSafe'
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

  // 5b. The SFPM temporarily mints an ERC-1155 position to its caller. Safe
  // accounts only accept that callback through a compatible fallback handler.
  if (config.SFPM_SWAP_PROVISIONED) {
    const sfpmAddress = config.SFPM_SWAP_ADDRESS_V3
    if (sfpmAddress === undefined) {
      push(skip('safe-erc1155', 'Safe ERC-1155 receiver', 'missing v3 SFPM address'))
    } else {
      try {
        await assertSafeCanReceiveErc1155({
          publicClient,
          safeAddress: config.SAFE_ADDRESS,
          tokenAddress: sfpmAddress,
        })
        push({
          id: 'safe-erc1155',
          title: 'Safe ERC-1155 receiver',
          status: 'pass',
          detail: 'fallback handler accepts SFPM position mints',
        })
      } catch (err) {
        push({
          id: 'safe-erc1155',
          title: 'Safe ERC-1155 receiver',
          status: 'fail',
          detail: msg(err),
          remedy:
            'Have the Safe owners set the reviewed CompatibilityFallbackHandler before enabling the SFPM venue.',
        })
      }
    }
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
  let token0Asset: Address | undefined
  let token1Asset: Address | undefined
  let collateralTracker0: Address | undefined
  let collateralTracker1: Address | undefined
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
    token0Asset = md.token0Asset
    token1Asset = md.token1Asset
    collateralTracker0 = md.collateralToken0Address
    collateralTracker1 = md.collateralToken1Address
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

  let sfpmSwap: SfpmSwapConfigureInput | undefined
  if (config.SFPM_SWAP_PROVISIONED) {
    const sfpmAddress = config.SFPM_SWAP_ADDRESS_V3
    if (
      sfpmAddress === undefined ||
      config.SFPM_SWAP_POOL_ID === undefined ||
      config.MULTISEND_CALL_ONLY_ADDRESS === undefined ||
      config.MULTISEND_UNWRAPPER_ADDRESS === undefined ||
      token0Asset === undefined ||
      token1Asset === undefined ||
      collateralTracker0 === undefined ||
      collateralTracker1 === undefined
    ) {
      push({
        id: 'sfpm-authorization',
        title: 'SFPM venue authorization',
        status: 'fail',
        detail: 'SFPM venue configuration or pool metadata is incomplete',
        remedy:
          'Run pnpm migrate:sfpm-venue, approve the Safe batch, and apply the exact .env block it prints.',
      })
    } else {
      const sides = [
        { asset: token0Asset, ct: collateralTracker0, key: 'token0' as const },
        { asset: token1Asset, ct: collateralTracker1, key: 'token1' as const },
      ]
      const nativeSide = sides.find(
        ({ asset }) => asset.toLowerCase() === zeroAddress.toLowerCase(),
      )
      const weth9 = walletWethAddress(config)
      const approvals: SfpmSwapConfigureInput['approvals'] = []
      for (const side of sides) {
        if (side.asset.toLowerCase() === zeroAddress.toLowerCase()) continue
        approvals.push({ token: side.asset, spender: sfpmAddress })
        approvals.push({ token: side.asset, spender: side.ct })
      }
      if (nativeSide && weth9) {
        approvals.push({ token: weth9, spender: sfpmAddress })
      }
      sfpmSwap = {
        sfpm: sfpmAddress,
        collateralTracker0,
        collateralTracker1,
        adapter: CANONICAL_ADAPTERS.SfpmSwapCondition,
        poolIdPin: config.SFPM_SWAP_POOL_ID,
        multiSendCallOnly: config.MULTISEND_CALL_ONLY_ADDRESS,
        multiSendUnwrapper: config.MULTISEND_UNWRAPPER_ADDRESS,
        nativeCollateral: nativeSide?.key ?? 'none',
        weth9,
        approvals,
      }
      try {
        await verifySfpmSwapReady(publicClient, {
          safeAddress: config.SAFE_ADDRESS,
          rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
          roleKey: config.ROLE_KEY,
          deploymentBlock: await findContractDeploymentBlock(
            publicClient,
            config.ROLES_MODIFIER_ADDRESS,
          ),
          sfpmSwap,
        })
        push({
          id: 'sfpm-authorization',
          title: 'SFPM venue authorization',
          status: 'pass',
          detail: 'handler, Roles scopes, MultiSend unwrapper, and token approvals verified',
        })
      } catch (err) {
        push({
          id: 'sfpm-authorization',
          title: 'SFPM venue authorization',
          status: 'fail',
          detail: msg(err),
          remedy: 'Run pnpm migrate:sfpm-venue, approve the Safe batch, then re-run doctor.',
        })
      }
    }
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
      const manifestDiff = await inspectExactAuthorizationManifest({
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
        sfpmSwap: sfpmSwap
          ? {
              roleKey: config.ROLE_KEY,
              safe: config.SAFE_ADDRESS,
              sfpm: sfpmSwap.sfpm,
              collateralTracker0: sfpmSwap.collateralTracker0,
              collateralTracker1: sfpmSwap.collateralTracker1,
              adapter: sfpmSwap.adapter,
              poolIdPin: sfpmSwap.poolIdPin,
              multiSendCallOnly: sfpmSwap.multiSendCallOnly,
              multiSendUnwrapper: sfpmSwap.multiSendUnwrapper,
              nativeCollateral: sfpmSwap.nativeCollateral,
              weth9: sfpmSwap.weth9,
            }
          : undefined,
      })
      const mismatch =
        manifestDiff.missing.length > 0 ||
        manifestDiff.unexpected.length > 0 ||
        manifestDiff.changed.length > 0
      if (mismatch) {
        push({
          id: 'permission-manifest',
          title: 'Complete Roles permission manifest',
          status: 'fail',
          detail: formatAuthorizationManifestDiff(manifestDiff),
          remedy:
            'Run `pnpm onboard`; it will keep this Safe and offer a fresh dedicated modifier.',
        })
      } else {
        push({
          id: 'permission-manifest',
          title: 'Complete Roles permission manifest',
          status: 'pass',
          detail:
            `exact reviewed loan-only permission graph` +
            `${config.DELEVERAGER_ENABLED ? ' + burn-only deleverager' : ''}` +
            `${sfpmSwap ? ' + SFPM venue' : ''}`,
        })
      }
    } catch (err) {
      push({
        id: 'permission-manifest',
        title: 'Complete Roles permission manifest',
        status: 'fail',
        detail: msg(err),
        remedy: 'Run `pnpm onboard`; it will keep this Safe and offer a fresh dedicated modifier.',
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
      const signal = await waitForPriceSignal(source)
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

  // 11. Uniswap LP subgraph freshness (only when LP tracking is configured).
  //     A lagging subgraph is not fatal — the runtime guard forces observe-only —
  //     but the operator should know their LP delta is (or would be) suppressed.
  if (config.HEDGE_INCLUDE_LP || config.UNISWAP_LP_OWNER) {
    try {
      const [chainHead, pool] = await Promise.all([
        publicClient.getBlockNumber(),
        getPool({
          client: asSdkClient<typeof getPool>(publicClient),
          poolAddress: config.POOL_ADDRESS,
          chainId: BigInt(config.CHAIN_ID),
        }),
      ])
      const owners = config.UNISWAP_LP_OWNER
        ? [config.SAFE_ADDRESS, config.UNISWAP_LP_OWNER]
        : [config.SAFE_ADDRESS]
      const res = await readSafeLpPositions({
        url: config.LP_SUBGRAPH_URL,
        owners,
        token0: pool.poolKey.currency0,
        token1: pool.poolKey.currency1,
      })
      const mode = config.HEDGE_INCLUDE_LP ? 'fold into hedge' : 'observe-only'
      if (!res.ok) {
        push({
          id: 'lp-subgraph',
          title: 'Uniswap LP subgraph',
          status: config.HEDGE_INCLUDE_LP ? 'warn' : 'skip',
          detail: `query failed against ${config.LP_SUBGRAPH_URL} (mode: ${mode})`,
          remedy: config.HEDGE_INCLUDE_LP
            ? 'LP delta will be treated as observe-only until the subgraph responds; check LP_SUBGRAPH_URL.'
            : undefined,
        })
      } else {
        const lag = chainHead > res.headBlock ? chainHead - res.headBlock : 0n
        const fresh = res.headBlock > 0n && lag <= config.LP_SUBGRAPH_MAX_LAG_BLOCKS
        push({
          id: 'lp-subgraph',
          title: 'Uniswap LP subgraph',
          // Only a fold-mode stale subgraph is worth a warning (it suppresses a
          // delta the operator expects to be applied); observe-only stays pass.
          status: fresh || !config.HEDGE_INCLUDE_LP ? 'pass' : 'warn',
          detail:
            `${res.positions.length} same-pair position(s); head=${res.headBlock} ` +
            `chain=${chainHead} lag=${lag} (max ${config.LP_SUBGRAPH_MAX_LAG_BLOCKS}); ` +
            `${fresh ? 'fresh' : 'STALE'}; mode: ${mode}`,
          remedy:
            fresh || !config.HEDGE_INCLUDE_LP
              ? undefined
              : 'Subgraph lags chain head: LP delta will be observe-only (not hedged) until it catches up.',
        })
      }
    } catch (err) {
      push({
        id: 'lp-subgraph',
        title: 'Uniswap LP subgraph',
        status: config.HEDGE_INCLUDE_LP ? 'warn' : 'skip',
        detail: msg(err),
        remedy:
          'Could not read the pool or LP subgraph — verify RPC_URL, POOL_ADDRESS, and LP_SUBGRAPH_URL.',
      })
    }
  }

  // 12. Telegram delivery (optional).
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
