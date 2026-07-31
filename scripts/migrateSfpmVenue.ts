import 'dotenv/config'

import { fileURLToPath } from 'node:url'

import { encodeFunctionData, zeroAddress } from 'viem'

import { parseHedgerBotConfig } from '../src/config'
import { assertSafeCanReceiveErc1155, readSafeFallbackHandler } from '../src/safe/erc1155Receiver'
import { sanitizeError } from '../src/utils/sanitize'
import { type SfpmSwapConfigureInput, buildSfpmSwapConfigureCalls } from './lib/deployCore'
import { buildDiagnosticsContext } from './lib/diagnostics/context'
import { type SafeProposalCall, emitSafeTransactionBuilderBatch } from './lib/safeProposal'
import { getSafeZodiacAddresses, verifySafeZodiacBytecode } from './lib/safeZodiacRegistry'
import { resolveSfpmSwap } from './setup'

const safeAbi = [
  {
    type: 'function',
    name: 'setFallbackHandler',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'handler', type: 'address' }],
    outputs: [],
  },
] as const

export function buildSfpmVenueMigrationCalls(params: {
  safeAddress: `0x${string}`
  rolesModifierAddress: `0x${string}`
  roleKey: `0x${string}`
  sfpmSwap: SfpmSwapConfigureInput
  fallbackHandler?: `0x${string}`
}): SafeProposalCall[] {
  const calls: SafeProposalCall[] = []
  if (params.fallbackHandler) {
    calls.push({
      description: 'Set the Safe CompatibilityFallbackHandler for ERC-1155 callbacks',
      policy: `handler=${params.fallbackHandler}`,
      to: params.safeAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: 'setFallbackHandler',
        args: [params.fallbackHandler],
      }),
    })
  }
  calls.push(
    ...buildSfpmSwapConfigureCalls(params).map((call) => ({
      ...call,
      policy: 'canonical SFPM venue onboarding permission/approval',
    })),
  )
  return calls
}

function printEnvPatch(env: {
  SFPM_SWAP_PROVISIONED?: boolean
  SFPM_SWAP_POOL_VERSION?: string
  SFPM_SWAP_ADDRESS_V3?: `0x${string}`
  SFPM_SWAP_POOL_ADDRESS?: `0x${string}`
  SFPM_SWAP_POOL_ID?: string
  SFPM_SWAP_FEE?: number
  WETH_ADDRESS?: `0x${string}`
  MULTISEND_CALL_ONLY_ADDRESS?: `0x${string}`
  MULTISEND_UNWRAPPER_ADDRESS?: `0x${string}`
}): void {
  console.error('\nAfter the Safe batch confirms, add/update this block in .env:')
  const values = {
    ...env,
    SFPM_SWAP_PROVISIONED: 'true',
    SFPM_SWAP_ENABLED: 'true',
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) console.error(`${key}=${value}`)
  }
  console.error('\nThen run: pnpm run doctor')
  console.error('Keep DRY_RUN=true and run: pnpm inspect:hedge')
  console.error('Re-run pnpm activate before returning the bot to live trading.')
}

/**
 * A repair command must remain usable when the SFPM execution flags are the
 * broken state it exists to repair. All unrelated configuration is still
 * validated normally.
 */
export function parseSfpmMigrationConfig(env: NodeJS.ProcessEnv = process.env) {
  return parseHedgerBotConfig({
    ...env,
    SFPM_SWAP_PROVISIONED: 'false',
    SFPM_SWAP_ENABLED: 'false',
  })
}

async function main(): Promise<void> {
  const config = parseSfpmMigrationConfig()
  const { publicClient } = await buildDiagnosticsContext(config)
  const addresses = getSafeZodiacAddresses(config.CHAIN_ID)
  await verifySafeZodiacBytecode(publicClient, addresses)
  const sfpm = await resolveSfpmSwap({
    chainId: config.CHAIN_ID,
    poolAddress: config.POOL_ADDRESS,
    publicClient,
    multiSendCallOnly: addresses.multiSend,
  })
  if (!sfpm) {
    throw new Error(`no reviewed SFPM swap venue is registered for chain ${config.CHAIN_ID}`)
  }

  const currentHandler = await readSafeFallbackHandler(publicClient, config.SAFE_ADDRESS)
  if (currentHandler !== zeroAddress) {
    await assertSafeCanReceiveErc1155({
      publicClient,
      safeAddress: config.SAFE_ADDRESS,
      tokenAddress: sfpm.configure.sfpm,
    })
  }
  const calls = buildSfpmVenueMigrationCalls({
    safeAddress: config.SAFE_ADDRESS,
    rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
    roleKey: config.ROLE_KEY,
    sfpmSwap: sfpm.configure,
    fallbackHandler:
      currentHandler === zeroAddress ? addresses.compatibilityFallbackHandler : undefined,
  })

  emitSafeTransactionBuilderBatch({
    chainId: config.CHAIN_ID,
    safeAddress: config.SAFE_ADDRESS,
    name: 'Migrate hedger-bot SFPM venue prerequisites',
    description:
      'Adds the complete reviewed SFPM venue surface: Safe ERC-1155 receive support, MultiSend unwrapper, SFPM/CT/WETH role scopes, and token approvals. No transaction is sent by this command.',
    calls,
  })
  printEnvPatch(sfpm.env)
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((error: unknown) => {
    console.error(sanitizeError(error))
    process.exitCode = 1
  })
}
