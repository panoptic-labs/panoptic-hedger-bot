import type { Address, Hex } from 'viem'
import { getAddress } from 'viem'

export interface SafeProposalCall {
  description: string
  policy?: string
  to: Address
  value: bigint
  data: Hex
}

/**
 * An unsigned, threshold-agnostic batch for review/import in Safe Transaction
 * Builder. This module never resolves, accepts, or handles a Safe-owner key.
 */
export function buildSafeTransactionBuilderBatch(params: {
  chainId: number
  safeAddress: Address
  name: string
  description: string
  calls: readonly SafeProposalCall[]
}) {
  if (params.calls.length === 0) throw new Error('Safe proposal must contain at least one call')
  return {
    version: '1.0',
    chainId: String(params.chainId),
    createdAt: Date.now(),
    meta: {
      name: params.name,
      description: params.description,
      txBuilderVersion: '1.18.0',
      createdFromSafeAddress: getAddress(params.safeAddress),
      createdFromOwnerAddress: '',
    },
    transactions: params.calls.map((call) => ({
      to: getAddress(call.to),
      value: call.value.toString(),
      data: call.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  }
}

/** Print review text to stderr and clean importable JSON to stdout. */
export function emitSafeTransactionBuilderBatch(params: {
  chainId: number
  safeAddress: Address
  name: string
  description: string
  calls: readonly SafeProposalCall[]
}): void {
  console.error(`Safe proposal: ${params.name}`)
  console.error(`Safe: ${getAddress(params.safeAddress)} (chain ${params.chainId})`)
  console.error(
    'No transaction was sent. Review and import the JSON below in Safe Transaction Builder.',
  )
  params.calls.forEach((call, index) => {
    console.error(`${index + 1}. ${call.description}`)
    console.error(
      `   to=${getAddress(call.to)} value=${call.value} selector=${call.data.slice(0, 10)}`,
    )
    if (call.policy) console.error(`   policy=${call.policy}`)
  })
  console.log(JSON.stringify(buildSafeTransactionBuilderBatch(params), null, 2))
}
