import type { Address, Hex } from 'viem'
import { concatHex, encodeFunctionData, size } from 'viem'

/** One inner call of a MultiSend batch (all plain Call, operation=0). */
export interface MultiSendCall {
  to: Address
  value: bigint
  data: Hex
}

const multiSendAbi = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

/**
 * Pack calls into the Gnosis MultiSend `transactions` blob and encode the
 * `multiSend(bytes)` calldata. Each entry is
 * `operation(1) | to(20) | value(32) | dataLength(32) | data`.
 *
 * The resulting calldata is executed by the Safe via DELEGATECALL to the
 * MultiSend contract (routed through the Roles modifier with operation=1),
 * which is how a Safe batches cross-contract calls atomically.
 */
export function encodeMultiSend(calls: MultiSendCall[]): Hex {
  const packed = concatHex(
    calls.map((call) => {
      const dataLen = BigInt(size(call.data))
      return concatHex([
        '0x00', // operation = Call
        pad20(call.to),
        pad32(call.value),
        pad32(dataLen),
        call.data,
      ])
    }),
  )
  return encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [packed] })
}

const UINT256_MAX = (1n << 256n) - 1n

function pad20(addr: Address): Hex {
  // Must be exactly 20 bytes (40 hex chars + 0x) or the packed layout corrupts.
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`multiSend: invalid 20-byte address ${addr}`)
  }
  return addr.toLowerCase() as Hex
}

function pad32(value: bigint): Hex {
  // Reject negatives and anything wider than 32 bytes — either would overflow
  // the fixed-width field and shift every subsequent byte in the blob.
  if (value < 0n || value > UINT256_MAX) {
    throw new Error(`multiSend: value ${value} out of uint256 range`)
  }
  return `0x${value.toString(16).padStart(64, '0')}`
}
