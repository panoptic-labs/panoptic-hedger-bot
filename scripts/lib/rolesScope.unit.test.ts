import { createTokenIdBuilder } from '@panoptic-eng/sdk/v2'
import { describe, expect, it } from 'vitest'

import { loanWidthFieldsMask } from './loanTokenIdMask'
import {
  type ConditionFlat,
  addressEqualCompValue,
  buildDepositConditions,
  buildLoanOnlyDispatchConditions,
  buildWithdrawConditions,
  Operator,
  ParameterType,
} from './rolesScope'

const SAFE = '0x1111111111111111111111111111111111111111' as const

// ---------------------------------------------------------------------------
// Replica of Roles v2 PermissionChecker._bitmask (zodiac-modifier-roles
// packages/evm/contracts/PermissionChecker.sol):
//   shift    = uint16(bytes2(compValue))            — BYTE offset from the left
//   mask     = (compValue << 16) & bytes15(-1)      — LEFT-aligned 15 bytes
//   expected = (compValue << (16+120)) & bytes15(-1)
//   slice    = bytes32(value[shift:])               — right-padded with zeros
//   ok iff (slice & mask) == expected
// ---------------------------------------------------------------------------
function bitmaskAllows(value: bigint, compValue: `0x${string}`): boolean {
  const cv = compValue.slice(2).padStart(64, '0')
  const shift = parseInt(cv.slice(0, 4), 16)
  if (shift >= 32) return false // Status.BitmaskOverflow
  const mask = BigInt(`0x${cv.slice(4, 34)}`) << 136n // left-align in a bytes32
  const expected = BigInt(`0x${cv.slice(34, 64)}`) << 136n
  const valueHex = value.toString(16).padStart(64, '0') + '0'.repeat(64)
  const slice = BigInt(`0x${valueHex.slice(shift * 2, shift * 2 + 64)}`)
  return (slice & mask) === expected
}

/**
 * Evaluate the positionIdList element condition of the dispatch scope against a
 * tokenId, the way the deployed modifier would: collect every Bitmask node under
 * the ArrayEvery subtree (directly or under And) and require ALL to pass.
 * Zero Bitmask nodes means the tokenId is unconstrained (allows anything).
 */
function dispatchScopeAllowsTokenId(conditions: ConditionFlat[], tokenId: bigint): boolean {
  const arrayEvery = conditions.findIndex((c) => c.operator === Operator.ArrayEvery)
  expect(arrayEvery).toBeGreaterThanOrEqual(0)
  const inSubtree = (i: number): boolean =>
    i > 0 &&
    i !== arrayEvery &&
    (conditions[i].parent === arrayEvery || inSubtree(conditions[i].parent))
  const bitmasks = conditions.filter((c, i) => inSubtree(i) && c.operator === Operator.Bitmask)
  return bitmasks.every((c) => bitmaskAllows(tokenId, c.compValue))
}

const POOL_ID = 0x123456789abcdef0n

/** The bot's own hedge loan: single leg, width=0. Must be allowed. */
const LOAN = createTokenIdBuilder(POOL_ID)
  .addLoan({ asset: 1n, tokenType: 1n, strike: -8870n, optionRatio: 1n })
  .build()

/** A single-leg short call (width>0): an option, must be rejected. */
const ONE_LEG_OPTION = createTokenIdBuilder(POOL_ID)
  .addCall({ strike: 100n, width: 10n, optionRatio: 1n, isLong: false })
  .build()

/** Four-leg option: every leg has width>0, must be rejected. */
const FOUR_LEG_OPTION = createTokenIdBuilder(POOL_ID)
  .addCall({ strike: 100n, width: 10n, optionRatio: 1n, isLong: false })
  .addCall({ strike: 200n, width: 10n, optionRatio: 1n, isLong: false })
  .addPut({ strike: -100n, width: 10n, optionRatio: 1n, isLong: false })
  .addPut({ strike: -200n, width: 10n, optionRatio: 1n, isLong: false })
  .build()

/** Adversarial: width bits set ONLY in leg N (raw bit math per SDK layout). */
const widthOnlyInLeg = (leg: bigint) => POOL_ID | (1n << (64n + leg * 48n + 36n))

describe('rolesScope — Roles v2 encoding correctness', () => {
  it('uses the Roles v2 Operator ordinals (Bitmask=21, And=1)', () => {
    // zodiac-modifier-roles Types.sol: ...EqualTo=16, GreaterThan=17, LessThan=18,
    // SignedIntGreaterThan=19, SignedIntLessThan=20, Bitmask=21.
    expect(Operator.Bitmask).toBe(21)
    expect(Operator.And).toBe(1)
  })

  it('dispatch conditions are in BFS order (Integrity.sol NotBFS check)', () => {
    const c = buildLoanOnlyDispatchConditions()
    for (let i = 1; i < c.length; i++) {
      expect(c[i - 1].parent).toBeLessThanOrEqual(c[i].parent)
    }
  })

  it('every Array node has children; ArrayEvery has exactly one (UnsuitableChildCount)', () => {
    const c = buildLoanOnlyDispatchConditions()
    c.forEach((node, i) => {
      const children = c.filter((child, j) => j !== i && child.parent === i)
      if (node.paramType === ParameterType.Array) {
        expect(children.length, `Array node ${i} needs >=1 child`).toBeGreaterThanOrEqual(1)
      }
      if (node.operator === Operator.ArrayEvery) {
        expect(children.length, `ArrayEvery node ${i} needs exactly 1 child`).toBe(1)
      }
    })
  })

  it('allows the bot loan tokenId through the element bitmask(s)', () => {
    const c = buildLoanOnlyDispatchConditions()
    expect(dispatchScopeAllowsTokenId(c, LOAN)).toBe(true)
  })

  it('rejects option tokenIds — width>0 in any leg position', () => {
    const c = buildLoanOnlyDispatchConditions()
    expect(dispatchScopeAllowsTokenId(c, ONE_LEG_OPTION)).toBe(false)
    expect(dispatchScopeAllowsTokenId(c, FOUR_LEG_OPTION)).toBe(false)
    for (const leg of [0n, 1n, 2n, 3n]) {
      expect(
        dispatchScopeAllowsTokenId(c, widthOnlyInLeg(leg)),
        `width bit in leg ${leg} must be rejected`,
      ).toBe(false)
    }
  })

  it('the bitmask windows jointly cover the full width-fields mask', () => {
    const c = buildLoanOnlyDispatchConditions()
    const bitmasks = c.filter((n) => n.operator === Operator.Bitmask)
    let covered = 0n
    for (const n of bitmasks) {
      const cv = n.compValue.slice(2)
      const shift = BigInt(parseInt(cv.slice(0, 4), 16))
      const mask = BigInt(`0x${cv.slice(4, 34)}`)
      // left-aligned 15-byte mask over value[shift..shift+15): bit i of the
      // bytes32 window corresponds to tokenId bit (255 - shift*8 - (255 - i)).
      covered |= (mask << 136n) >> (shift * 8n)
    }
    expect(covered & loanWidthFieldsMask()).toBe(loanWidthFieldsMask())
  })
})

describe('rolesScope', () => {
  it('encodes an address as a 32-byte left-padded EqualTo compValue', () => {
    const cv = addressEqualCompValue(SAFE)
    expect(cv).toBe(`0x${'0'.repeat(24)}${SAFE.slice(2)}`)
    expect(cv).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('loan dispatch scope: bitmask on positionIdList elements, finalPositionIdList passes', () => {
    const c = buildLoanOnlyDispatchConditions()
    expect(c[1].operator).toBe(Operator.ArrayEvery) // positionIdList
    expect(c[1].parent).toBe(0)
    expect(c[2].operator).toBe(Operator.Pass) // finalPositionIdList unconstrained
    expect(c[2].paramType).toBe(ParameterType.Array)
    // The element constraint lives under the ArrayEvery subtree as Bitmask node(s).
    expect(c.some((n) => n.operator === Operator.Bitmask)).toBe(true)
  })

  it('withdraw scope pins receiver and owner to the Safe', () => {
    const c = buildWithdrawConditions(SAFE)
    const safeEq = addressEqualCompValue(SAFE)
    expect(c[1].operator).toBe(Operator.Pass) // assets
    expect(c[2]).toMatchObject({ operator: Operator.EqualTo, compValue: safeEq }) // receiver
    expect(c[3]).toMatchObject({ operator: Operator.EqualTo, compValue: safeEq }) // owner
    expect(c[2].paramType).toBe(ParameterType.Static)
  })

  it('deposit scope pins receiver to the Safe', () => {
    const c = buildDepositConditions(SAFE)
    expect(c[1].operator).toBe(Operator.Pass) // assets
    expect(c[2]).toMatchObject({
      operator: Operator.EqualTo,
      compValue: addressEqualCompValue(SAFE),
    })
  })
})
