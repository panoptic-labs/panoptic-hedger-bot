import type { Address, Log } from 'viem'
import { keccak256, pad, stringToHex } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { AccountEventMonitor, isRelevantAccountLog } from './accountEventMonitor'

const pool = '0x1111111111111111111111111111111111111111'
const collateral = '0x2222222222222222222222222222222222222222'
const account = '0x3333333333333333333333333333333333333333'
const other = '0x4444444444444444444444444444444444444444'
const optionMinted = keccak256(stringToHex('OptionMinted(address,uint256,uint256)'))
const topic = (address: Address) => pad(address, { size: 32 })

const log = (address: Address, topics: Log['topics']): Pick<Log, 'address' | 'topics'> => ({
  address,
  topics,
})

describe('isRelevantAccountLog', () => {
  it('matches the account at the event-specific indexed topic', () => {
    expect(
      isRelevantAccountLog(log(pool, [optionMinted, topic(account)]), pool, [collateral], account),
    ).toBe(true)
    expect(
      isRelevantAccountLog(log(pool, [optionMinted, topic(other)]), pool, [collateral], account),
    ).toBe(false)
  })

  it.each([
    ['OptionMinted(address,uint256,uint256)', 1],
    ['OptionBurnt(address,uint128,uint256,int256[4])', 1],
    ['ForcedExercised(address,address,uint256,int256)', 2],
    ['AccountLiquidated(address,address,int256)', 2],
    ['PremiumSettled(address,uint256,uint256,int256)', 1],
  ])('matches %s for the configured account', (signature, accountIndex) => {
    const topics = [keccak256(stringToHex(signature)), topic(other), topic(other)]
    topics[accountIndex] = topic(account)

    expect(isRelevantAccountLog(log(pool, topics), pool, [collateral], account)).toBe(true)
  })

  it('treats a collateral log mentioning the account as an invalidation hint', () => {
    expect(
      isRelevantAccountLog(
        log(collateral, [optionMinted, topic(account)]),
        pool,
        [collateral],
        account,
      ),
    ).toBe(true)
  })
})

describe('AccountEventMonitor', () => {
  it('advances incrementally and reports relevant changes', async () => {
    const getLogs = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([log(pool, [optionMinted, topic(account)])])
    const monitor = new AccountEventMonitor({ getLogs } as never, pool, [collateral], account)

    monitor.reset(100n)
    await expect(monitor.scan(101n)).resolves.toBe(false)
    await expect(monitor.scan(103n)).resolves.toBe(true)
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 101n, toBlock: 101n })
    expect(getLogs.mock.calls[1]?.[0]).toMatchObject({ fromBlock: 102n, toBlock: 103n })
  })
})
