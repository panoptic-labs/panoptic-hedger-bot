import { createTokenIdBuilder } from '@panoptic-eng/sdk/v2'
import { describe, expect, it } from 'vitest'

import { isPureLoanTokenId, loanBitmaskCondition, loanWidthFieldsMask } from './loanTokenIdMask'

const POOL_ID = 0x1234abcdn

describe('loanTokenIdMask', () => {
  it('classifies a single-leg loan as a pure loan', () => {
    const loan = createTokenIdBuilder(POOL_ID)
      .addLoan({ asset: 1n, tokenType: 1n, strike: 0n })
      .build()
    expect(isPureLoanTokenId(loan)).toBe(true)
  })

  it('classifies a credit (width=0) as a pure loan', () => {
    const credit = createTokenIdBuilder(POOL_ID)
      .addCredit({ asset: 0n, tokenType: 0n, strike: 100n })
      .build()
    expect(isPureLoanTokenId(credit)).toBe(true)
  })

  it('rejects an option position (width>0)', () => {
    const option = createTokenIdBuilder(POOL_ID)
      .addCall({ optionRatio: 1n, isLong: true, strike: 100n, width: 2n })
      .build()
    expect(isPureLoanTokenId(option)).toBe(false)
  })

  it('rejects a mixed position (loan leg + option leg)', () => {
    const mixed = createTokenIdBuilder(POOL_ID)
      .addLoan({ asset: 1n, tokenType: 1n, strike: 0n })
      .addPut({ optionRatio: 1n, isLong: false, strike: -50n, width: 5n })
      .build()
    expect(isPureLoanTokenId(mixed)).toBe(false)
  })

  it('mask ignores the poolId region (nonzero poolId, loan still pure)', () => {
    const loan = createTokenIdBuilder(0xffffffffffffffffn)
      .addLoan({ asset: 1n, tokenType: 1n, strike: 0n })
      .build()
    expect(isPureLoanTokenId(loan)).toBe(true)
  })

  it('exposes a 32-byte bitmask condition with zero expected', () => {
    const { mask, expected } = loanBitmaskCondition()
    expect(mask).toMatch(/^0x[0-9a-f]{64}$/)
    expect(expected).toBe(`0x${'0'.repeat(64)}`)
    expect(BigInt(mask)).toBe(loanWidthFieldsMask())
  })
})
