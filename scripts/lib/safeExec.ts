import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from 'viem'
import { encodePacked, zeroAddress } from 'viem'

import { type FeeOptions, resolveTxFees, waitForReceiptResilient } from './txWait'

/** Minimal Safe ABI: execTransaction only. */
export const safeExecAbi = [
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

/**
 * Execute a call through a 1-of-1 Safe using a pre-validated signature (the
 * caller is the Safe's sole owner, so no ECDSA signature is needed). Throws if
 * the Safe transaction reverts.
 *
 * Fees always carry a non-zero priority tip (see txWait) and the receipt wait is
 * resilient to a slow-but-successful inclusion. When `simulate` is set, the call
 * is dry-run first so a reverting inner call surfaces its reason locally instead
 * of costing gas — important for batched MultiSend payloads.
 */
export async function execFromSoleOwner(params: {
  publicClient: PublicClient
  walletClient: WalletClient<Transport, Chain, Account>
  safeAddress: `0x${string}`
  to: `0x${string}`
  data: `0x${string}`
  /** Zodiac Enum.Operation: 0 = Call (default), 1 = DelegateCall. */
  operation?: 0 | 1
  feeOptions?: FeeOptions
  timeoutMs?: number
  simulate?: boolean
  log?: (line: string) => void
}): Promise<Hash> {
  const { publicClient, walletClient, safeAddress, to, data, operation = 0 } = params
  const owner = walletClient.account
  // Pre-validated signature: r = owner address, s = 0, v = 1.
  const preValidatedSig = encodePacked(
    ['uint256', 'uint256', 'uint8'],
    [BigInt(owner.address), 0n, 1],
  )
  const args = [
    to,
    0n,
    data,
    operation,
    0n,
    0n,
    0n,
    zeroAddress,
    zeroAddress,
    preValidatedSig,
  ] as const

  if (params.simulate) {
    // Reverts here throw with the decoded reason before any gas is spent.
    await publicClient.simulateContract({
      account: owner,
      address: safeAddress,
      abi: safeExecAbi,
      functionName: 'execTransaction',
      args,
    })
  }

  const fees = await resolveTxFees(publicClient, params.feeOptions)
  const hash = await walletClient.writeContract({
    account: owner,
    chain: walletClient.chain,
    address: safeAddress,
    abi: safeExecAbi,
    functionName: 'execTransaction',
    args,
    ...fees,
  })
  const receipt = await waitForReceiptResilient(publicClient, hash, {
    timeoutMs: params.timeoutMs,
    log: params.log,
  })
  if (receipt.status !== 'success') {
    throw new Error(`Safe execTransaction reverted (tx ${hash})`)
  }
  return hash
}
