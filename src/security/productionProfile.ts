import type { HedgerBotConfig } from '../config'

export const PRODUCTION_ROLE_POLICY =
  'single-member-single-pool-in-pool-loan-role-no-extra-keeper-roles' as const

type ProfileConfig = Pick<HedgerBotConfig, 'CHAIN_ID'> & {
  PRICE_SIGNAL_SOURCE: string
}

const PRODUCTION_SIGNAL_SOURCES = new Set(['cex', 'pool-tick'])

export function productionProfileViolations(config: ProfileConfig): string[] {
  const violations: string[] = []
  if (config.CHAIN_ID !== 1) violations.push('only Ethereum mainnet is production-eligible')
  if (!PRODUCTION_SIGNAL_SOURCES.has(config.PRICE_SIGNAL_SOURCE)) {
    violations.push(
      config.PRICE_SIGNAL_SOURCE === 'uniswap-pool'
        ? 'the uniswap-pool signal is experimental'
        : `PRICE_SIGNAL_SOURCE=${config.PRICE_SIGNAL_SOURCE} is not production-eligible`,
    )
  }
  return violations
}

export function isProductionEligibleConfig(config: ProfileConfig): boolean {
  return productionProfileViolations(config).length === 0
}

export function assertProductionEligibleConfig(config: ProfileConfig): void {
  const violations = productionProfileViolations(config)
  if (violations.length > 0) {
    throw new Error(`configured profile is not production-eligible: ${violations.join('; ')}`)
  }
}
