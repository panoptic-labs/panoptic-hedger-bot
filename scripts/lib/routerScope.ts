import { buildV3SwapExecuteArgs, buildV4SwapExecuteArgs } from '@panoptic-eng/sdk/uniswap'
import type { PoolKey } from '@panoptic-eng/sdk/v2'
import type { Address, Hex } from 'viem'
import { keccak256, zeroAddress } from 'viem'

import { type ConditionFlat, Operator, ParameterType } from './rolesScope'

/**
 * Zodiac Roles v2 scope for `UniversalRouter.execute(bytes,bytes[],uint256)`
 * that lets the bot swap through a WHITELIST of Uniswap pools (v3 and/or v4)
 * WITHOUT an adapter contract, while guaranteeing the swap output can only be
 * delivered to the Safe.
 *
 * Why no recipient can be redirected, for either version:
 *   - v4 (SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL): TAKE_ALL's recipient is
 *     hardwired by v4-periphery to msgSender = the execute caller = the Safe.
 *     There is no recipient field in the calldata.
 *   - v3 (V3_SWAP_EXACT_IN): the recipient IS an explicit field, but the SDK
 *     encodes it as the sentinel MSG_SENDER (address(1)); we PIN it, so it can
 *     only ever resolve to the caller (the Safe).
 *
 * So the residual risk is a compromised key submitting a DIFFERENT shape
 * (explicit-recipient TAKE, SWEEP / PERMIT2_TRANSFER_FROM commands, or a swap on
 * a pool that is not whitelisted). The scope pins the shape:
 *   - `commands` must equal exactly one V4_SWAP (0x10) or one V3_SWAP_EXACT_IN
 *     (0x00) — Or of only the versions present in the whitelist. The router
 *     enforces inputs.length == commands.length, so exactly one input.
 *   - every `inputs` element must match ONE of the whitelisted pool templates
 *     (an Or of per-pool, per-direction variants), each an And of 15-byte
 *     Bitmask windows pinning all structural bytes, the recipient word, and the
 *     pool identity (v4 PoolKey / v3 path). Only the amount words stay free.
 *
 * ⚠️  MIXED v3+v4 CROSS-PRODUCT. Because commands and inputs are checked
 * independently, the scope also admits mismatched combos (a v4 command with a
 * v3-shaped input and vice versa). These are NOT exploitable for theft: in every
 * template the recipient-equivalent word is pinned (v4 word 0 = the ABI offset
 * 0x40; v3 word 0 = MSG_SENDER), so no attacker address can appear. The worst
 * case is a revert or a burn to a fixed non-attacker address. This must still be
 * fork-validated to confirm it reverts, alongside the MultiSend unwrap wiring.
 *
 * ⚠️  VALIDATE ON A FORK BEFORE MAINNET (see rolesScope.ts banner).
 */

/** A whitelisted hedge swap venue (same token pair as the vault). */
export type HedgeSwapPool =
  | ({ version: 'v4' } & PoolKey)
  | { version: 'v3'; currency0: Address; currency1: Address; fee: bigint }

/** Universal Router command bytes. */
export const V4_SWAP_COMMAND = 0x10
export const V3_SWAP_EXACT_IN_COMMAND = 0x00

const BITMASK_WINDOW_BYTES = 15

/**
 * v4 input words that legitimately vary per hedge (unconstrained):
 *   15 zeroForOne · 16 amountIn · 17 amountOutMinimum ·
 *   21/22 SETTLE_ALL (currency, amount) · 24/25 TAKE_ALL (currency, amount)
 */
export const VARIABLE_V4_WORDS = new Set([15, 16, 17, 21, 22, 24, 25])
/** v3 input words that vary: 1 amountIn · 2 amountOutMinimum. */
export const VARIABLE_V3_WORDS = new Set([1, 2])

/**
 * Roles v2 EqualTo compValue for a Dynamic param: keccak256 over the plucked
 * payload = 32-byte length word ++ content right-padded to a 32-byte multiple
 * (AbiDecoder sizes Dynamic params as `32 + ceil32(length)`).
 */
export function dynamicEqualToCompValue(value: Hex): Hex {
  const content = value.slice(2)
  const byteLength = content.length / 2
  const paddedLength = Math.ceil(byteLength / 32) * 32
  const lengthWord = byteLength.toString(16).padStart(64, '0')
  const padded = content.padEnd(paddedLength * 2, '0')
  return keccak256(`0x${lengthWord}${padded}`)
}

/** The bot's canonical v4 input for a pool, variable fields zeroed. */
export function buildTemplateV4Input(poolKey: PoolKey): Hex {
  if (poolKey.currency0 === zeroAddress || poolKey.currency1 === zeroAddress) {
    throw new Error(
      'native-ETH hedge pools are not supported by the router scope (native TAKE/SWEEP shapes carry an explicit recipient) — use a WETH pool or an adapter',
    )
  }
  const { args } = buildV4SwapExecuteArgs({
    poolKey: { ...poolKey },
    zeroForOne: true,
    amountIn: 0n,
    amountOutMinimum: 0n,
    tokenIn: poolKey.currency0,
    tokenOut: poolKey.currency1,
    deadline: 0n,
  })
  return args[1][0]
}

/** The bot's canonical v3 input for one direction of a pool, amounts zeroed. */
export function buildTemplateV3Input(tokenIn: Address, tokenOut: Address, fee: bigint): Hex {
  const { args } = buildV3SwapExecuteArgs({
    tokenIn,
    tokenOut,
    fee,
    amountIn: 0n,
    amountOutMinimum: 0n,
    deadline: 0n,
  })
  return args[1][0]
}

/**
 * Chop a template into `uint16 shift | bytes15 mask | bytes15 expected` Bitmask
 * compValues, masking out the given variable words. All-zero windows are
 * dropped (nothing to constrain there). Inputs shorter than the template fail
 * on-chain via BitmaskOverflow.
 */
export function buildTemplateBitmaskCompValues(template: Hex, variableWords: Set<number>): Hex[] {
  const bytes = template.slice(2).match(/.{2}/g) ?? []
  const compValues: Hex[] = []
  for (let shift = 0; shift < bytes.length; shift += BITMASK_WINDOW_BYTES) {
    let mask = ''
    let expected = ''
    for (let i = shift; i < shift + BITMASK_WINDOW_BYTES; i++) {
      const pinned = i < bytes.length && !variableWords.has(Math.floor(i / 32))
      mask += pinned ? 'ff' : '00'
      expected += pinned ? bytes[i] : '00'
    }
    if (/^0+$/.test(mask)) continue
    compValues.push(`0x${shift.toString(16).padStart(4, '0')}${mask}${expected}` as Hex)
  }
  return compValues
}

/** One accepted calldata shape: a command byte + the pinned input windows. */
interface SwapVariant {
  commandByte: number
  windows: Hex[]
}

/** Expand a whitelisted pool into its accepted variants (v3 has 2 directions). */
function variantsForPool(pool: HedgeSwapPool): SwapVariant[] {
  if (pool.version === 'v4') {
    const template = buildTemplateV4Input(pool)
    return [
      {
        commandByte: V4_SWAP_COMMAND,
        windows: buildTemplateBitmaskCompValues(template, VARIABLE_V4_WORDS),
      },
    ]
  }
  // v3: pin the path per direction (direction lives in the path bytes).
  return [[pool.currency0, pool.currency1] as const, [pool.currency1, pool.currency0] as const].map(
    ([tokenIn, tokenOut]) => ({
      commandByte: V3_SWAP_EXACT_IN_COMMAND,
      windows: buildTemplateBitmaskCompValues(
        buildTemplateV3Input(tokenIn, tokenOut, pool.fee),
        VARIABLE_V3_WORDS,
      ),
    }),
  )
}

// ---------------------------------------------------------------------------
// Nested-condition builder → BFS-flat ConditionFlat[] (Roles requires parent
// indices to be non-decreasing; BFS insertion order guarantees that).
// ---------------------------------------------------------------------------
interface NestedNode {
  paramType: number
  operator: number
  compValue: Hex
  children: NestedNode[]
}
const node = (
  paramType: number,
  operator: number,
  compValue: Hex,
  children: NestedNode[] = [],
): NestedNode => ({ paramType, operator, compValue, children })

function flattenBfs(root: NestedNode): ConditionFlat[] {
  const out: ConditionFlat[] = []
  const queue: { n: NestedNode; parent: number }[] = [{ n: root, parent: 0 }]
  while (queue.length > 0) {
    const { n, parent } = queue.shift() as { n: NestedNode; parent: number }
    const idx = out.length
    out.push({ parent, paramType: n.paramType, operator: n.operator, compValue: n.compValue })
    for (const child of n.children) queue.push({ n: child, parent: idx })
  }
  return out
}

/** And(windows): a Dynamic-bytes element pinned by every Bitmask window. */
function variantNode(v: SwapVariant): NestedNode {
  const windows = v.windows.map((cv) => node(ParameterType.Dynamic, Operator.Bitmask, cv))
  return windows.length === 1 ? windows[0] : node(ParameterType.None, Operator.And, '0x', windows)
}

/**
 * Build the ConditionFlat[] tree for `execute(bytes commands, bytes[] inputs,
 * uint256 deadline)` scoped to the whitelisted pools.
 */
export function buildRouterExecuteConditions(pools: HedgeSwapPool[]): ConditionFlat[] {
  if (pools.length === 0) throw new Error('router scope requires at least one whitelisted pool')

  const variants = pools.flatMap(variantsForPool)
  const commandBytes = [...new Set(variants.map((v) => v.commandByte))].sort((a, b) => a - b)

  // commands: EqualTo one byte, or Or of the (2) present command bytes.
  const commandLeaf = (b: number): NestedNode =>
    node(
      ParameterType.Dynamic,
      Operator.EqualTo,
      dynamicEqualToCompValue(`0x${b.toString(16).padStart(2, '0')}` as Hex),
    )
  const commandsNode =
    commandBytes.length === 1
      ? commandLeaf(commandBytes[0])
      : node(ParameterType.None, Operator.Or, '0x', commandBytes.map(commandLeaf))

  // inputs element: one variant (And) or Or of variants.
  const variantNodes = variants.map(variantNode)
  const elementNode =
    variantNodes.length === 1
      ? variantNodes[0]
      : node(ParameterType.None, Operator.Or, '0x', variantNodes)

  const root = node(ParameterType.Calldata, Operator.Matches, '0x', [
    commandsNode, // arg0 commands
    node(ParameterType.Array, Operator.ArrayEvery, '0x', [elementNode]), // arg1 inputs
    node(ParameterType.Static, Operator.Pass, '0x'), // arg2 deadline
  ])
  return flattenBfs(root)
}
