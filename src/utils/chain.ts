import { type Chain, defineChain } from 'viem'

/**
 * Canonical Multicall3, deployed at the same address on mainnet, base, and
 * virtually every EVM chain. viem's `multicall` (used by SDK reads like
 * getPoolMetadata) needs this configured on the chain, which a bare
 * `defineChain` omits.
 */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

/**
 * Build the viem chain the bot + scripts use from a chainId + RPC URL. Injects
 * the canonical Multicall3 so on-chain reads that batch via multicall work on
 * any chain (custom `defineChain` has no contract registry by default).
 */
export function defineBotChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  })
}
