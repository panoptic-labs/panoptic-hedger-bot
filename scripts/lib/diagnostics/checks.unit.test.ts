import { createPublicClient, custom } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../../../src/config'
import { defineBotChain } from '../../../src/utils/chain'
import { runDoctorChecks } from './checks'
import type { DiagnosticsContext } from './context'

const account = privateKeyToAccount(generatePrivateKey())
const config = parseHedgerBotConfig({
  CHAIN_ID: '1',
  RPC_URL: 'https://synthetic.invalid',
  POOL_ADDRESS: '0x1111111111111111111111111111111111111111',
  SAFE_ADDRESS: '0x2222222222222222222222222222222222222222',
  ROLES_MODIFIER_ADDRESS: '0x3333333333333333333333333333333333333333',
  ROLE_KEY: `0x${'44'.repeat(32)}`,
  BOT_PRIVATE_KEY: generatePrivateKey(),
  ASSET_INDEX: '1',
  DRY_RUN: 'true',
})
const chain = defineBotChain(config.CHAIN_ID, config.RPC_URL)

function client(chainId: number | Error) {
  return createPublicClient({
    chain,
    transport: custom({
      request: async ({ method }) => {
        if (method !== 'eth_chainId') throw new Error(`unexpected method ${method}`)
        if (chainId instanceof Error) throw chainId
        return `0x${chainId.toString(16)}`
      },
    }),
  })
}

function ctx(over: Partial<DiagnosticsContext>): DiagnosticsContext {
  return {
    config,
    chain,
    publicClient: client(new Error('unconfigured test client')),
    ...over,
  }
}

const byId = (rs: { id: string; status: string }[], id: string) => rs.find((r) => r.id === id)

describe('runDoctorChecks (offline short-circuit)', () => {
  it('fails RPC + key and skips on-chain checks when the RPC is unreachable', async () => {
    const results = await runDoctorChecks(
      ctx({
        publicClient: client(new Error('boom')),
        accountError: new Error('no key'),
      }),
    )
    expect(byId(results, 'rpc')?.status).toBe('fail')
    expect(byId(results, 'key')?.status).toBe('fail')
    expect(byId(results, 'contracts')?.status).toBe('skip')
    // Nothing past the short-circuit ran.
    expect(byId(results, 'scope')).toBeUndefined()
  })

  it('fails RPC on a chain-id mismatch but passes the key check when the account resolved', async () => {
    const results = await runDoctorChecks(ctx({ publicClient: client(8453), account }))
    expect(byId(results, 'rpc')?.status).toBe('fail')
    expect(byId(results, 'key')?.status).toBe('pass')
    expect(byId(results, 'contracts')?.status).toBe('skip')
  })
})
