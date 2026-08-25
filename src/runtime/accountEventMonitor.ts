import type { Address, Log, PublicClient } from 'viem'
import { keccak256, pad, stringToHex } from 'viem'

const eventTopic = (signature: string) => keccak256(stringToHex(signature))

const ACCOUNT_TOPICS = new Map([
  [eventTopic('AccountLiquidated(address,address,int256)'), 2],
  [eventTopic('ForcedExercised(address,address,uint256,int256)'), 2],
  [eventTopic('OptionBurnt(address,uint128,uint256,int256[4])'), 1],
  [eventTopic('OptionMinted(address,uint256,uint256)'), 1],
  [eventTopic('PremiumSettled(address,uint256,uint256,int256)'), 1],
])

function accountTopic(account: Address): `0x${string}` {
  return pad(account, { size: 32 }).toLowerCase() as `0x${string}`
}

export function isRelevantAccountLog(
  log: Pick<Log, 'address' | 'topics'>,
  poolAddress: Address,
  accountStateAddresses: readonly Address[],
  account: Address,
): boolean {
  const expected = accountTopic(account)
  const address = log.address.toLowerCase()
  if (address === poolAddress.toLowerCase()) {
    const signature = log.topics[0]
    if (!signature) return false
    const accountIndex = ACCOUNT_TOPICS.get(signature)
    return accountIndex !== undefined && log.topics[accountIndex]?.toLowerCase() === expected
  }
  return (
    accountStateAddresses.some((candidate) => candidate.toLowerCase() === address) &&
    log.topics.some((topic) => topic?.toLowerCase() === expected)
  )
}

/** Incrementally scans only the configured account's state-changing logs. */
export class AccountEventMonitor {
  private cursor: bigint | undefined
  private readonly publicClient: PublicClient
  private readonly poolAddress: Address
  private readonly accountStateAddresses: readonly Address[]
  private readonly account: Address

  constructor(
    publicClient: PublicClient,
    poolAddress: Address,
    accountStateAddresses: readonly Address[],
    account: Address,
  ) {
    this.publicClient = publicClient
    this.poolAddress = poolAddress
    this.accountStateAddresses = accountStateAddresses
    this.account = account
  }

  reset(blockNumber: bigint): void {
    if (this.cursor === undefined || blockNumber > this.cursor) this.cursor = blockNumber
  }

  get lastScannedBlock(): bigint | undefined {
    return this.cursor
  }

  async scan(toBlock: bigint): Promise<boolean> {
    if (this.cursor === undefined) {
      this.cursor = toBlock
      return false
    }
    if (toBlock <= this.cursor) return false
    const logs = await this.publicClient.getLogs({
      address: [this.poolAddress, ...this.accountStateAddresses],
      fromBlock: this.cursor + 1n,
      toBlock,
    })
    this.cursor = toBlock
    return logs.some((log) =>
      isRelevantAccountLog(log, this.poolAddress, this.accountStateAddresses, this.account),
    )
  }
}
