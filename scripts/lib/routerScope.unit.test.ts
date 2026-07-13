import { buildV3SwapExecuteArgs, buildV4SwapExecuteArgs } from '@panoptic-eng/sdk/uniswap'
import type { PoolKey } from '@panoptic-eng/sdk/v2'
import type { Hex } from 'viem'
import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { type ConditionFlat, Operator, ParameterType } from './rolesScope'
import {
  type HedgeSwapPool,
  buildRouterExecuteConditions,
  buildTemplateBitmaskCompValues,
  buildTemplateV4Input,
  dynamicEqualToCompValue,
  V3_SWAP_EXACT_IN_COMMAND,
  V4_SWAP_COMMAND,
  VARIABLE_V4_WORDS,
} from './routerScope'

type RouterScopePoolKey = PoolKey

const CUR0 = '0x1111111111111111111111111111111111111111' as const
const CUR1 = '0x2222222222222222222222222222222222222222' as const
const ATTACKER = '0x4444444444444444444444444444444444444444' as const

const V4_POOL: HedgeSwapPool = {
  version: 'v4',
  currency0: CUR0,
  currency1: CUR1,
  fee: 500n,
  tickSpacing: 10n,
  hooks: zeroAddress,
}
const V4_POOL_HIFEE: HedgeSwapPool = {
  ...(V4_POOL as RouterScopePoolKey),
  version: 'v4',
  fee: 3000n,
  tickSpacing: 60n,
}
const V3_POOL: HedgeSwapPool = { version: 'v3', currency0: CUR0, currency1: CUR1, fee: 3000n }
const UNLISTED_V4: HedgeSwapPool = {
  ...(V4_POOL as RouterScopePoolKey),
  version: 'v4',
  fee: 10000n,
  tickSpacing: 200n,
}

const cmd = (b: number): Hex => `0x${b.toString(16).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// Replica of the Roles v2 on-chain checks (PermissionChecker.sol) sufficient to
// evaluate this scope's tree:
//   - Bitmask on a Dynamic param: applied to the bytes CONTENT past the length
//     word; shift >= content length ⇒ BitmaskOverflow; 15-byte mask/expected
//     left-aligned against bytes32(content[shift:]).
//   - EqualTo on Dynamic: keccak256 over (length word ++ padded content).
//   - And = all children; Or = any child; Pass = true.
// ---------------------------------------------------------------------------
function dynamicBitmaskAllows(contentHex: string, compValue: Hex): boolean {
  const cv = compValue.slice(2)
  const shift = parseInt(cv.slice(0, 4), 16)
  if (shift >= contentHex.length / 2) return false // BitmaskOverflow
  const mask = BigInt(`0x${cv.slice(4, 34)}`) << 136n
  const expected = BigInt(`0x${cv.slice(34, 64)}`) << 136n
  const slice = BigInt(`0x${(contentHex + '0'.repeat(64)).slice(shift * 2, shift * 2 + 64)}`)
  return (slice & mask) === expected
}

function childrenOf(c: ConditionFlat[], idx: number): number[] {
  return c.map((_, j) => j).filter((j) => j !== idx && c[j].parent === idx)
}

function evalDynamic(c: ConditionFlat[], idx: number, content: string): boolean {
  const n = c[idx]
  switch (n.operator) {
    case Operator.And:
      return childrenOf(c, idx).every((j) => evalDynamic(c, j, content))
    case Operator.Or:
      return childrenOf(c, idx).some((j) => evalDynamic(c, j, content))
    case Operator.Bitmask:
      return dynamicBitmaskAllows(content, n.compValue)
    case Operator.EqualTo:
      return dynamicEqualToCompValue(`0x${content}`) === n.compValue
    case Operator.Pass:
      return true
    default:
      throw new Error(`unexpected operator ${n.operator}`)
  }
}

function makeChecker(pools: HedgeSwapPool[]) {
  const c = buildRouterExecuteConditions(pools)
  const [commandsIdx, inputsIdx] = childrenOf(c, 0)
  const elementIdx = childrenOf(c, inputsIdx)[0]
  // Third arg (deadline) is ignored — lets callers spread an execute() arg tuple.
  return (commands: Hex, inputs: readonly Hex[], _deadline?: bigint): boolean =>
    evalDynamic(c, commandsIdx, commands.slice(2)) &&
    inputs.every((i) => evalDynamic(c, elementIdx, i.slice(2)))
}

function v4Args(pool: RouterScopePoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint) {
  return buildV4SwapExecuteArgs({
    poolKey: { ...pool },
    zeroForOne,
    amountIn,
    amountOutMinimum: minOut,
    tokenIn: zeroForOne ? pool.currency0 : pool.currency1,
    tokenOut: zeroForOne ? pool.currency1 : pool.currency0,
    deadline: 1n,
  }).args
}
function v3Args(tokenIn: Hex, tokenOut: Hex, fee: bigint, amountIn: bigint, minOut: bigint) {
  return buildV3SwapExecuteArgs({
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    amountOutMinimum: minOut,
    deadline: 1n,
  }).args
}
function tamper(input: Hex, byteOffset: number, bytesHex: string): Hex {
  const s = input.slice(2)
  return `0x${s.slice(0, byteOffset * 2)}${bytesHex}${s.slice(byteOffset * 2 + bytesHex.length)}` as Hex
}

describe('routerScope — v4-only whitelist', () => {
  const allowed = makeChecker([V4_POOL])

  it('allows both directions and any amounts', () => {
    for (const [z, a, m] of [
      [true, 1n, 1n],
      [false, 10n ** 18n, 42n],
    ] as const) {
      const [commands, inputs] = v4Args(V4_POOL as RouterScopePoolKey, z, a, m)
      expect(commands).toBe(cmd(V4_SWAP_COMMAND))
      expect(allowed(commands, inputs)).toBe(true)
    }
  })

  it('rejects explicit-recipient TAKE (0x0e) and a hostile poolKey', () => {
    const [commands, inputs] = v4Args(V4_POOL as RouterScopePoolKey, true, 5n, 1n)
    expect(allowed(commands, [tamper(inputs[0], 98, '0e')])).toBe(false) // actions 06 0c 0f → 06 0c 0e
    expect(allowed(commands, [tamper(inputs[0], 332, ATTACKER.slice(2))])).toBe(false) // currency0
  })

  it('rejects a swap on an unlisted v4 pool (different fee)', () => {
    const [commands, inputs] = v4Args(UNLISTED_V4 as RouterScopePoolKey, true, 5n, 1n)
    expect(allowed(commands, inputs)).toBe(false)
  })
})

describe('routerScope — v3-only whitelist', () => {
  const allowed = makeChecker([V3_POOL])

  it('allows both path directions', () => {
    expect(allowed(cmd(V3_SWAP_EXACT_IN_COMMAND), v3Args(CUR0, CUR1, 3000n, 5n, 1n)[1])).toBe(true)
    expect(allowed(cmd(V3_SWAP_EXACT_IN_COMMAND), v3Args(CUR1, CUR0, 3000n, 5n, 1n)[1])).toBe(true)
  })

  it('rejects a redirected recipient, a wrong fee, and a hostile token', () => {
    const [commands, inputs] = v3Args(CUR0, CUR1, 3000n, 5n, 1n)
    expect(allowed(commands, [tamper(inputs[0], 12, ATTACKER.slice(2))])).toBe(false) // recipient word 0
    expect(allowed(cmd(V3_SWAP_EXACT_IN_COMMAND), v3Args(CUR0, CUR1, 500n, 5n, 1n)[1])).toBe(false) // fee not whitelisted
    expect(allowed(commands, [tamper(inputs[0], 192, ATTACKER.slice(2))])).toBe(false) // path tokenIn (word 6)
  })

  it('the v3 command byte differs from v4', () => {
    const [commands] = v3Args(CUR0, CUR1, 3000n, 5n, 1n)
    expect(commands).toBe(cmd(V3_SWAP_EXACT_IN_COMMAND))
    expect(commands).not.toBe(cmd(V4_SWAP_COMMAND))
  })
})

describe('routerScope — multi-pool whitelist', () => {
  it('allows swaps on every listed v4 pool, rejects unlisted ones', () => {
    const allowed = makeChecker([V4_POOL, V4_POOL_HIFEE])
    expect(allowed(...v4Args(V4_POOL as RouterScopePoolKey, true, 5n, 1n))).toBe(true)
    expect(allowed(...v4Args(V4_POOL_HIFEE as RouterScopePoolKey, true, 5n, 1n))).toBe(true)
    expect(allowed(...v4Args(UNLISTED_V4 as RouterScopePoolKey, true, 5n, 1n))).toBe(false)
  })
})

describe('routerScope — mixed v3 + v4 whitelist', () => {
  const pools = [V4_POOL, V3_POOL]
  const allowed = makeChecker(pools)

  it('allows the intended v4 and v3 swaps', () => {
    expect(allowed(...v4Args(V4_POOL as RouterScopePoolKey, true, 5n, 1n))).toBe(true)
    expect(allowed(cmd(V3_SWAP_EXACT_IN_COMMAND), v3Args(CUR0, CUR1, 3000n, 5n, 1n)[1])).toBe(true)
  })

  it('commands is an Or over exactly the two present command bytes', () => {
    const c = buildRouterExecuteConditions(pools)
    const commandsIdx = childrenOf(c, 0)[0]
    expect(c[commandsIdx].operator).toBe(Operator.Or)
    const leaves = childrenOf(c, commandsIdx).map((j) => c[j])
    expect(leaves.every((n) => n.operator === Operator.EqualTo)).toBe(true)
    expect(leaves).toHaveLength(2)
  })

  it('admits the cross-product (documented) but NO combo yields an attacker recipient', () => {
    // The scope checks commands and inputs independently, so a v4 command paired
    // with a v3-shaped input is admitted — on-chain it reverts. It is NOT theft:
    const v3input = v3Args(CUR0, CUR1, 3000n, 5n, 1n)[1]
    const v4input = v4Args(V4_POOL as RouterScopePoolKey, true, 5n, 1n)[1]
    expect(allowed(cmd(V4_SWAP_COMMAND), v3input)).toBe(true) // cross admitted
    expect(allowed(cmd(V3_SWAP_EXACT_IN_COMMAND), v4input)).toBe(true) // cross admitted

    // ...but the recipient-equivalent word (0) is pinned in every accepted input,
    // so no attacker address can ever be the recipient under any command:
    expect(allowed(cmd(V4_SWAP_COMMAND), [tamper(v3input[0], 12, ATTACKER.slice(2))])).toBe(false)
    expect(
      allowed(cmd(V3_SWAP_EXACT_IN_COMMAND), [tamper(v4input[0], 12, ATTACKER.slice(2))]),
    ).toBe(false)
  })
})

describe('routerScope — template & tree invariants', () => {
  it('v4 template pins every structural byte and frees exactly the variable words', () => {
    const template = buildTemplateV4Input(V4_POOL as RouterScopePoolKey)
    const totalBytes = template.slice(2).length / 2
    expect(totalBytes).toBe(832)
    const covered = new Set<number>()
    for (const cv of buildTemplateBitmaskCompValues(template, VARIABLE_V4_WORDS)) {
      const shift = parseInt(cv.slice(2, 6), 16)
      const mask = cv.slice(6, 36)
      for (let i = 0; i < 15; i++) if (mask.slice(i * 2, i * 2 + 2) === 'ff') covered.add(shift + i)
    }
    for (let b = 0; b < totalBytes; b++) {
      expect(covered.has(b), `byte ${b}`).toBe(!VARIABLE_V4_WORDS.has(Math.floor(b / 32)))
    }
  })

  it('rejects native-ETH v4 pools', () => {
    expect(() =>
      buildRouterExecuteConditions([
        { ...(V4_POOL as RouterScopePoolKey), version: 'v4', currency0: zeroAddress },
      ]),
    ).toThrow(/native-ETH/)
  })

  it('rejects an empty whitelist', () => {
    expect(() => buildRouterExecuteConditions([])).toThrow(/at least one/)
  })

  it('the flat condition tree is BFS-ordered with the expected top-level shape', () => {
    const c = buildRouterExecuteConditions([V4_POOL, V3_POOL])
    for (let i = 1; i < c.length; i++) expect(c[i - 1].parent).toBeLessThanOrEqual(c[i].parent)
    expect(c[0].paramType).toBe(ParameterType.Calldata)
    const [commandsIdx, inputsIdx, deadlineIdx] = childrenOf(c, 0)
    expect(c[inputsIdx].operator).toBe(Operator.ArrayEvery)
    expect(childrenOf(c, inputsIdx)).toHaveLength(1) // ArrayEvery: exactly one child
    expect(c[deadlineIdx].operator).toBe(Operator.Pass)
    expect(commandsIdx).toBeLessThan(inputsIdx)
  })
})
