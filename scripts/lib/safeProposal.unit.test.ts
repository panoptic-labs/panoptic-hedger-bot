import type { Address, Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { buildSafeTransactionBuilderBatch, emitSafeTransactionBuilderBatch } from './safeProposal'

const SAFE: Address = '0x1111111111111111111111111111111111111111'
const MODIFIER: Address = '0x2222222222222222222222222222222222222222'
const CALL_A: Hex = '0x12345678'
const CALL_B: Hex = '0xabcdef01'

describe('Safe administration proposals', () => {
  const params = {
    chainId: 1,
    safeAddress: SAFE,
    name: 'Synthetic role update',
    description: 'Synthetic test batch',
    calls: [
      { description: 'first policy change', to: MODIFIER, value: 0n, data: CALL_A },
      { description: 'second policy change', to: MODIFIER, value: 0n, data: CALL_B },
    ],
  }

  it('emits an unsigned threshold-agnostic Transaction Builder batch', () => {
    const batch = buildSafeTransactionBuilderBatch(params)
    expect(batch.meta.createdFromSafeAddress).toBe(SAFE)
    expect(batch.meta.createdFromOwnerAddress).toBe('')
    expect(batch.transactions).toEqual([
      {
        to: MODIFIER,
        value: '0',
        data: CALL_A,
        contractMethod: null,
        contractInputsValues: null,
      },
      {
        to: MODIFIER,
        value: '0',
        data: CALL_B,
        contractMethod: null,
        contractInputsValues: null,
      },
    ])
  })

  it('keeps human review output separate from importable JSON', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    emitSafeTransactionBuilderBatch(params)
    expect(() => JSON.parse(stdout.mock.calls[0][0])).not.toThrow()
    expect(stderr.mock.calls.flat().join(' ')).toContain('No transaction was sent')
    stdout.mockRestore()
    stderr.mockRestore()
  })
})
