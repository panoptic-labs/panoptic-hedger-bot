import { describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../../src/config'
import { buildActivationCandidate } from './guidedActivation'

const BASE_ENV = {
  CHAIN_ID: '1',
  RPC_URL: 'https://rpc.example',
  POOL_ADDRESS: '0x1111111111111111111111111111111111111111',
  SAFE_ADDRESS: '0x2222222222222222222222222222222222222222',
  ROLES_MODIFIER_ADDRESS: '0x3333333333333333333333333333333333333333',
  ROLE_KEY: `0x${'11'.repeat(32)}`,
  BOT_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  ASSET_INDEX: '1',
  DRY_RUN: 'true',
} satisfies NodeJS.ProcessEnv

describe('guided activation candidate', () => {
  it('keeps SFPM disabled when its authorization surface is not provisioned', () => {
    const candidate = buildActivationCandidate(parseHedgerBotConfig(BASE_ENV), true)
    expect(candidate.DRY_RUN).toBe(false)
    expect(candidate.SFPM_SWAP_ENABLED).toBe(false)
  })
})
