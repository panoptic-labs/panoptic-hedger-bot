import type { Address, PublicClient } from 'viem'
import { getAddress, zeroAddress } from 'viem'

const ERC1155_RECEIVED = '0xf23a6e61'
const FALLBACK_HANDLER_STORAGE_SLOT =
  '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'

const erc1155ReceiverAbi = [
  {
    type: 'function',
    name: 'onERC1155Received',
    stateMutability: 'view',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'id', type: 'uint256' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const

/** Read the Safe fallback handler without relying on an indexer. */
export async function readSafeFallbackHandler(
  publicClient: PublicClient,
  safeAddress: Address,
): Promise<Address> {
  const word = await publicClient.getStorageAt({
    address: safeAddress,
    slot: FALLBACK_HANDLER_STORAGE_SLOT,
  })
  if (word === undefined) return zeroAddress
  return getAddress(`0x${word.slice(-40)}`)
}

/**
 * Assert that the Safe can accept the transient ERC-1155 position minted by
 * the SFPM. Safe accounts expose token callbacks through their fallback handler.
 */
export async function assertSafeCanReceiveErc1155(params: {
  publicClient: PublicClient
  safeAddress: Address
  tokenAddress: Address
}): Promise<void> {
  const { publicClient, safeAddress, tokenAddress } = params
  const handler = await readSafeFallbackHandler(publicClient, safeAddress)
  if (handler === zeroAddress) {
    throw new Error(
      `Safe ${safeAddress} has no fallback handler; the SFPM swap requires an ERC-1155-compatible Safe fallback handler`,
    )
  }

  let response: `0x${string}`
  try {
    response = await publicClient.readContract({
      account: tokenAddress,
      address: safeAddress,
      abi: erc1155ReceiverAbi,
      functionName: 'onERC1155Received',
      args: [tokenAddress, zeroAddress, 0n, 1n, '0x'],
    })
  } catch {
    throw new Error(
      `Safe fallback handler ${handler} does not accept ERC-1155 tokens; the SFPM cannot mint its transient swap position`,
    )
  }
  if (response !== ERC1155_RECEIVED) {
    throw new Error(
      `Safe fallback handler ${handler} returned ${response} for onERC1155Received; expected ${ERC1155_RECEIVED}`,
    )
  }
}
