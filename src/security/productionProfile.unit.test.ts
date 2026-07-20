import { describe, expect, it } from 'vitest'

import {
  assertProductionEligibleConfig,
  isProductionEligibleConfig,
  productionProfileViolations,
} from './productionProfile'

const supported = {
  CHAIN_ID: 1,
  HEDGE_VENUE: 'in-pool' as const,
  PRICE_SIGNAL_SOURCE: 'cex' as const,
}

describe('production eligibility profile', () => {
  it('accepts the supported mainnet in-pool profile', () => {
    expect(isProductionEligibleConfig(supported)).toBe(true)
    expect(() => assertProductionEligibleConfig(supported)).not.toThrow()
    expect(isProductionEligibleConfig({ ...supported, PRICE_SIGNAL_SOURCE: 'pool-tick' })).toBe(
      true,
    )
  })

  it('rejects unsupported chains and experimental signals', () => {
    expect(
      productionProfileViolations({
        ...supported,
        CHAIN_ID: 8453,
        PRICE_SIGNAL_SOURCE: 'uniswap-pool',
      }),
    ).toEqual([
      'only Ethereum mainnet is production-eligible',
      'the uniswap-pool signal is experimental',
    ])
  })

  it('rejects signal sources outside the explicit production allowlist', () => {
    const unsupported = { ...supported, PRICE_SIGNAL_SOURCE: 'future-signal-source' }

    expect(productionProfileViolations(unsupported)).toEqual([
      'PRICE_SIGNAL_SOURCE=future-signal-source is not production-eligible',
    ])
    expect(isProductionEligibleConfig(unsupported)).toBe(false)
    expect(() => assertProductionEligibleConfig(unsupported)).toThrow(
      'PRICE_SIGNAL_SOURCE=future-signal-source is not production-eligible',
    )
  })
})
