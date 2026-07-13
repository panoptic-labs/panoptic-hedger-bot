import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import type { HedgerBotConfig } from '../../../src/config'
import { runDoctorChecks } from './checks'
import type { DiagnosticsContext } from './context'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

function ctx(over: Partial<DiagnosticsContext>): DiagnosticsContext {
  return {
    config: { CHAIN_ID: 1 } as unknown as HedgerBotConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: {} as any,
    ...over,
  }
}

const byId = (rs: { id: string; status: string }[], id: string) => rs.find((r) => r.id === id)

describe('runDoctorChecks (offline short-circuit)', () => {
  it('fails RPC + key and skips on-chain checks when the RPC is unreachable', async () => {
    const results = await runDoctorChecks(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx({
        publicClient: { getChainId: async () => Promise.reject(new Error('boom')) } as any,
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
    const results = await runDoctorChecks(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx({ publicClient: { getChainId: async () => 8453 } as any, account }),
    )
    expect(byId(results, 'rpc')?.status).toBe('fail')
    expect(byId(results, 'key')?.status).toBe('pass')
    expect(byId(results, 'contracts')?.status).toBe('skip')
  })
})
