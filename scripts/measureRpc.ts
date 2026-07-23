/**
 * Ad-hoc RPC-count measurement for the hedge snapshot read path (fork only).
 *
 *   anvil --fork-url $MAINNET_RPC_URL --port 8546
 *   pnpm tsx scripts/measureRpc.ts <owner-address>
 *
 * Counts JSON-RPC messages and HTTP round-trips for one readHedgeSnapshot()
 * with the production client config (transport batching + client multicall +
 * cached pool metadata) vs a naive unbatched client without the caches.
 */
import { createMemoryStorage, getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

import { readHedgeSnapshot } from '../src/hedge/snapshot'
import { asSdkClient } from '../src/utils/sdkClient'

const RPC_URL = process.env.HEDGER_FORK_RPC_URL ?? 'http://127.0.0.1:8546'
const POOL_ADDRESS = '0x00000000563b70d704f4c6675a5f6ac989fbae13' as `0x${string}`
const OWNER = (process.argv[2] ?? '0x0000000000000000000000000000000000000001') as `0x${string}`

function countingFetch() {
  const counts = { httpRequests: 0, rpcMessages: 0, byMethod: new Map<string, number>() }
  const fetchFn: typeof fetch = async (input, init) => {
    counts.httpRequests += 1
    const body = init?.body ? JSON.parse(String(init.body)) : []
    const messages = Array.isArray(body) ? body : [body]
    counts.rpcMessages += messages.length
    for (const message of messages) {
      counts.byMethod.set(message.method, (counts.byMethod.get(message.method) ?? 0) + 1)
    }
    return fetch(input, init)
  }
  return { counts, fetchFn }
}

async function measure(label: string, batched: boolean) {
  const { counts, fetchFn } = countingFetch()
  const transport = http(RPC_URL, { batch: batched, fetchFn })
  const publicClient = createPublicClient({
    chain: mainnet,
    transport,
    ...(batched ? { batch: { multicall: { wait: 16 } } } : {}),
    cacheTime: 0,
  })
  const poolMetadata = batched
    ? await getPoolMetadata({
        client: asSdkClient<typeof getPoolMetadata>(publicClient),
        poolAddress: POOL_ADDRESS,
      })
    : undefined
  // Metadata prefetch above is startup cost — count only the per-cycle reads.
  counts.httpRequests = 0
  counts.rpcMessages = 0
  counts.byMethod.clear()

  const snapshot = await readHedgeSnapshot({
    publicClient,
    poolAddress: POOL_ADDRESS,
    chainId: 1n,
    safeAddress: OWNER,
    poolMetadata,
    storage: createMemoryStorage(),
    fromBlock: (await publicClient.getBlockNumber()) - 5_000n,
  })
  console.log(`\n=== ${label} ===`)
  console.log(`positions=${snapshot.positions.length} block=${snapshot.blockNumber}`)
  console.log(`HTTP round-trips: ${counts.httpRequests}`)
  console.log(`JSON-RPC messages: ${counts.rpcMessages}`)
  console.log('by method:', Object.fromEntries(counts.byMethod))
}

await measure('optimized (batched + cached metadata)', true)
await measure('naive (unbatched, no metadata cache)', false)
