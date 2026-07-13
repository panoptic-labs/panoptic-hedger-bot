import 'dotenv/config'

import { type ScopeStep, applyScopeSteps } from '@panoptic-eng/sdk/zodiac'
import { createPublicClient, createWalletClient, http, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { defineBotChain } from '../src/utils/chain'
import {
  buildDepositConditions,
  buildLoanOnlyDispatchConditions,
  buildWithdrawConditions,
  DEPOSIT_SELECTOR,
  EXECUTE_SELECTOR,
  WITHDRAW_SELECTOR,
} from './lib/rolesScope'
import { type HedgeSwapPool, buildRouterExecuteConditions } from './lib/routerScope'

/**
 * Idempotently (re)scope the bot role on an already-deployed Zodiac Roles v2
 * modifier so the bot EOA can ONLY mint/burn width=0 loans via PanopticPool.dispatch.
 *
 * ⚠️  Dry-run on a fork first (see scripts/lib/rolesScope.ts banner + runbook.md).
 *
 * Required env:
 *   RPC_URL, CHAIN_ID, ROLES_MODIFIER_ADDRESS, POOL_ADDRESS, ROLE_KEY (bytes32),
 *   BOT_ADDRESS (role member), ROLES_OWNER_PRIVATE_KEY (owner/admin of the modifier)
 */

const DISPATCH_SELECTOR = toFunctionSelector(
  'dispatch(uint256[],uint256[],uint128[],int24[3][],bool,uint256)',
)
const MULTISEND_SELECTOR = toFunctionSelector('multiSend(bytes)')
const EXEC_OPTIONS_NONE = 0 // plain call, no value / no delegatecall
const EXEC_OPTIONS_DELEGATECALL = 2 // allow delegatecall (for the MultiSend batch)

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

/**
 * Parse the HEDGE_POOLS JSON (same shape the bot config uses) into router-scope
 * pools, injecting the fixed token pair. Each entry: v4 {version,fee,tickSpacing,
 * hooks?} or v3 {version,fee}.
 */
function parseHedgePools(
  json: string,
  currency0: `0x${string}`,
  currency1: `0x${string}`,
): HedgeSwapPool[] {
  const raw = JSON.parse(json) as Array<Record<string, unknown>>
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('HEDGE_POOLS must be a non-empty JSON array')
  }
  return raw.map((p): HedgeSwapPool => {
    if (p.version === 'v4') {
      return {
        version: 'v4',
        currency0,
        currency1,
        fee: BigInt(p.fee as number),
        tickSpacing: BigInt(p.tickSpacing as number),
        hooks: (p.hooks ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
      }
    }
    if (p.version === 'v3') {
      return { version: 'v3', currency0, currency1, fee: BigInt(p.fee as number) }
    }
    throw new Error(`HEDGE_POOLS entry has unknown version: ${String(p.version)}`)
  })
}

async function main(): Promise<void> {
  const chainId = Number(requireEnv('CHAIN_ID'))
  const rpcUrl = requireEnv('RPC_URL')
  const rolesModifier = requireEnv('ROLES_MODIFIER_ADDRESS') as `0x${string}`
  const pool = requireEnv('POOL_ADDRESS') as `0x${string}`
  const roleKey = requireEnv('ROLE_KEY') as `0x${string}`
  const botAddress = requireEnv('BOT_ADDRESS') as `0x${string}`
  const ownerKey = requireEnv('ROLES_OWNER_PRIVATE_KEY') as `0x${string}`

  const chain = defineBotChain(chainId, rpcUrl)
  const account = privateKeyToAccount(ownerKey)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })

  const conditions = buildLoanOnlyDispatchConditions()

  const steps: ScopeStep[] = [
    {
      name: 'assignRoles(bot)',
      functionName: 'assignRoles',
      args: [botAddress, [roleKey], [true]],
    },
    { name: 'scopeTarget(pool)', functionName: 'scopeTarget', args: [roleKey, pool] },
    {
      name: 'scopeFunction(dispatch, loan-only)',
      functionName: 'scopeFunction',
      args: [roleKey, pool, DISPATCH_SELECTOR, conditions, EXEC_OPTIONS_NONE],
    },
  ]

  // Cross-pool venue: additionally scope the MultiSend-unwrapped batch targets.
  // Enabled when all cross-pool env vars are present.
  const multiSend = process.env.MULTISEND_ADDRESS as `0x${string}` | undefined
  const unwrapper = process.env.MULTISEND_UNWRAPPER_ADDRESS as `0x${string}` | undefined
  const router = process.env.UNIVERSAL_ROUTER_ADDRESS as `0x${string}` | undefined
  const collateral0 = process.env.COLLATERAL0_ADDRESS as `0x${string}` | undefined
  const collateral1 = process.env.COLLATERAL1_ADDRESS as `0x${string}` | undefined
  if (multiSend && unwrapper && router && collateral0 && collateral1) {
    console.log('cross-pool venue detected — adding MultiSend unwrap + CT/router scopes')
    const safe = requireEnv('SAFE_ADDRESS') as `0x${string}`
    steps.push(
      // Register the MultiSend unwrapper so Roles re-checks each inner call.
      {
        name: 'setTransactionUnwrapper(multiSend)',
        functionName: 'setTransactionUnwrapper',
        args: [multiSend, MULTISEND_SELECTOR, unwrapper],
      },
      // Permit delegatecall to the MultiSend contract only.
      { name: 'scopeTarget(multiSend)', functionName: 'scopeTarget', args: [roleKey, multiSend] },
      {
        name: 'allowFunction(multiSend.multiSend, delegatecall)',
        functionName: 'allowFunction',
        args: [roleKey, multiSend, MULTISEND_SELECTOR, EXEC_OPTIONS_DELEGATECALL],
      },
      // CollateralTracker withdraw/deposit pinned to the Safe.
      {
        name: 'scopeTarget(collateral0)',
        functionName: 'scopeTarget',
        args: [roleKey, collateral0],
      },
      {
        name: 'scopeFunction(collateral0.withdraw→Safe)',
        functionName: 'scopeFunction',
        args: [
          roleKey,
          collateral0,
          WITHDRAW_SELECTOR,
          buildWithdrawConditions(safe),
          EXEC_OPTIONS_NONE,
        ],
      },
      {
        name: 'scopeFunction(collateral0.deposit→Safe)',
        functionName: 'scopeFunction',
        args: [
          roleKey,
          collateral0,
          DEPOSIT_SELECTOR,
          buildDepositConditions(safe),
          EXEC_OPTIONS_NONE,
        ],
      },
      {
        name: 'scopeTarget(collateral1)',
        functionName: 'scopeTarget',
        args: [roleKey, collateral1],
      },
      {
        name: 'scopeFunction(collateral1.withdraw→Safe)',
        functionName: 'scopeFunction',
        args: [
          roleKey,
          collateral1,
          WITHDRAW_SELECTOR,
          buildWithdrawConditions(safe),
          EXEC_OPTIONS_NONE,
        ],
      },
      {
        name: 'scopeFunction(collateral1.deposit→Safe)',
        functionName: 'scopeFunction',
        args: [
          roleKey,
          collateral1,
          DEPOSIT_SELECTOR,
          buildDepositConditions(safe),
          EXEC_OPTIONS_NONE,
        ],
      },
      { name: 'scopeTarget(router)', functionName: 'scopeTarget', args: [roleKey, router] },
    )

    // Router execute: calldata-template scope over the HEDGE_POOLS whitelist
    // (see scripts/lib/routerScope.ts). Pins commands to the present versions'
    // bytes and each accepted input to a whitelisted pool template; the swap
    // output is forced to the Safe (v4 TAKE_ALL msgSender / v3 pinned
    // MSG_SENDER). Requires TOKEN0/TOKEN1_ADDRESS + HEDGE_POOLS; falls back to
    // selector-only with a loud warning if absent.
    const token0 = process.env.TOKEN0_ADDRESS as `0x${string}` | undefined
    const token1 = process.env.TOKEN1_ADDRESS as `0x${string}` | undefined
    const hedgePoolsJson = process.env.HEDGE_POOLS
    if (token0 && token1 && hedgePoolsJson) {
      const pools = parseHedgePools(hedgePoolsJson, token0, token1)
      steps.push({
        name: `scopeFunction(router.execute, ${pools.length}-pool template)`,
        functionName: 'scopeFunction',
        args: [
          roleKey,
          router,
          EXECUTE_SELECTOR,
          buildRouterExecuteConditions(pools),
          EXEC_OPTIONS_NONE,
        ],
      })
    } else {
      console.warn(
        '⚠️  TOKEN0_ADDRESS/TOKEN1_ADDRESS/HEDGE_POOLS not set — falling back to selector-only ' +
          'router.execute (recipient/pool NOT constrained; see scripts/lib/routerScope.ts)',
      )
      steps.push({
        name: 'allowFunction(router.execute) — UNCONSTRAINED FALLBACK',
        functionName: 'allowFunction',
        args: [roleKey, router, EXECUTE_SELECTOR, EXEC_OPTIONS_NONE],
      })
    }
  }

  await applyScopeSteps({ publicClient, walletClient, rolesModifier, steps })
  console.log('bot role scoped to loan-only dispatch.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
