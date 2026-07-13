import type { Address, Hex } from 'viem'
import { decodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'

import { encodeMultiSend } from './multiSend'

const multiSendAbi = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

const A: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function transactionsBlob(data: Hex): Hex {
  const decoded = decodeFunctionData({ abi: multiSendAbi, data })
  return decoded.args[0] as Hex
}

describe('encodeMultiSend', () => {
  it('packs a single call as operation|to|value|len|data', () => {
    const blob = transactionsBlob(encodeMultiSend([{ to: A, value: 0n, data: '0xdeadbeef' }]))
    // 0x + 00 (op) + 20-byte to + 32-byte value(0) + 32-byte len(4) + deadbeef
    const op = '00'
    const to = A.slice(2)
    const value = '0'.repeat(64)
    const len = (4).toString(16).padStart(64, '0')
    const expected = `0x${op}${to}${value}${len}deadbeef`
    expect(blob.toLowerCase()).toBe(expected.toLowerCase())
  })

  it('concatenates multiple calls in order', () => {
    const blob = transactionsBlob(
      encodeMultiSend([
        { to: A, value: 0n, data: '0x' },
        { to: B, value: 1n, data: '0xab' },
      ]),
    )
    // First call: op+to(A)+value0+len0 (no data). Second: op+to(B)+value1+len1+ab
    expect(blob.toLowerCase()).toContain(A.slice(2).toLowerCase())
    expect(blob.toLowerCase()).toContain(B.slice(2).toLowerCase())
    expect(blob.toLowerCase().endsWith('ab')).toBe(true)
  })

  it('encodes the multiSend(bytes) selector', () => {
    const data = encodeMultiSend([{ to: A, value: 0n, data: '0x' }])
    expect(data.slice(0, 10)).toBe('0x8d80ff0a') // multiSend(bytes)
  })
})
