import type { Account, PublicClient } from 'viem'
import { formatEther, parseEther } from 'viem'

import type { Notifier } from '../notify/telegram'
import { botWarn } from '../utils/log'

/**
 * Gas policy for the hedger bot. The keeper EOA pays all gas (there is no
 * Safe refund mechanism), so this is purely bot-side economics:
 *
 *  - EIP-1559 fee caps on every send (`fees()`), so a network-estimator spike
 *    can never sign an unbounded-fee transaction.
 *  - A two-tier basefee deferral gate (`assess()`): routine hedges wait out
 *    gas spikes (delta drift for another poll interval is usually cheaper
 *    than spike gas), while urgent hedges — large drift — tolerate a much
 *    higher basefee. Positions don't expire; the only hard deadline is
 *    liquidation risk, which is exactly when the urgent tier applies.
 *  - A keeper balance watchdog (`checkKeeperBalance()`): an unfunded keeper
 *    is the most common way these bots silently die.
 */

export interface GasFees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface GasAssessment {
  proceed: boolean
  urgent: boolean
  baseFeeGwei: number
  capGwei: number
  /** True the first time a deferral streak starts (rate-limits skip alerts). */
  shouldNotifySkip: boolean
}

export interface GasPolicy {
  /** Gate a pending hedge on the current basefee. */
  assess(urgent: boolean): Promise<GasAssessment>
  /**
   * Fee-cap overrides for a send. Returns undefined on pre-EIP-1559 chains
   * (no basefee), letting the wallet client fall back to its own estimation.
   */
  fees(): Promise<GasFees | undefined>
  /** Alert (rate-limited) when the keeper EOA runs low on gas money. */
  checkKeeperBalance(): Promise<void>
}

export interface GasPolicyConfig {
  MAX_FEE_GWEI: number
  MAX_PRIORITY_FEE_GWEI: number
  HEDGE_MAX_BASE_FEE_GWEI: number
  URGENT_MAX_BASE_FEE_GWEI: number
  MIN_KEEPER_BALANCE_ETH: number
  KEEPER_BALANCE_WARN_ETH: number
}

export interface GasPolicyDeps {
  publicClient: PublicClient
  account: Account
  notifier: Notifier
  config: GasPolicyConfig
  /** Injectable clock for tests. */
  now?: () => number
}

const GWEI = 1_000_000_000n
const SKIP_ALERT_COOLDOWN_MS = 30 * 60 * 1000
const BALANCE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000

function toGweiNumber(wei: bigint): number {
  return Number(wei / 1_000_000n) / 1000 // 3 decimals is plenty for display
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1000)) * (GWEI / 1000n)
}

export function createGasPolicy(deps: GasPolicyDeps): GasPolicy {
  const { publicClient, account, notifier, config } = deps
  const now = deps.now ?? Date.now

  const maxFeeCap = gweiToWei(config.MAX_FEE_GWEI)
  const priorityCap = gweiToWei(config.MAX_PRIORITY_FEE_GWEI)
  // Only warn once the balance falls below this (defaults below the target
  // MIN_KEEPER_BALANCE_ETH, so routine balances above the warn line don't spam
  // the log every poll).
  const warnBalance = parseEther(String(config.KEEPER_BALANCE_WARN_ETH))

  // -Infinity = "never alerted", so the first breach always alerts even at t=0.
  let lastSkipAlertAt = Number.NEGATIVE_INFINITY
  let lastBalanceAlertAt = Number.NEGATIVE_INFINITY

  async function baseFee(): Promise<bigint | null> {
    const block = await publicClient.getBlock({ blockTag: 'latest' })
    return block.baseFeePerGas ?? null
  }

  return {
    async assess(urgent: boolean): Promise<GasAssessment> {
      const base = await baseFee()
      const capGwei = urgent ? config.URGENT_MAX_BASE_FEE_GWEI : config.HEDGE_MAX_BASE_FEE_GWEI
      // No basefee (pre-1559 chain): the deferral gate can't apply.
      const proceed = base === null || base <= gweiToWei(capGwei)
      let shouldNotifySkip = false
      if (!proceed) {
        const t = now()
        if (t - lastSkipAlertAt >= SKIP_ALERT_COOLDOWN_MS) {
          lastSkipAlertAt = t
          shouldNotifySkip = true
        }
      } else {
        lastSkipAlertAt = Number.NEGATIVE_INFINITY // streak over; next deferral alerts again
      }
      return {
        proceed,
        urgent,
        baseFeeGwei: base === null ? 0 : toGweiNumber(base),
        capGwei,
        shouldNotifySkip,
      }
    },

    async fees(): Promise<GasFees | undefined> {
      const base = await baseFee()
      if (base === null) return undefined
      // Tip = the network-estimated priority fee, clamped to MAX_PRIORITY_FEE_GWEI
      // (a true ceiling, not the paid value) so quiet networks pay the small tip
      // they actually need instead of a flat cap. If the RPC can't estimate,
      // fall back to the cap (previous behavior). The tip also never exceeds the
      // fee cap itself.
      const ceil = priorityCap > maxFeeCap ? maxFeeCap : priorityCap
      let estimated: bigint
      try {
        estimated = await publicClient.estimateMaxPriorityFeePerGas()
      } catch {
        estimated = ceil
      }
      const maxPriorityFeePerGas = estimated > ceil ? ceil : estimated
      // Standard headroom: 2x current basefee + tip, hard-clamped to the fee cap.
      const uncapped = 2n * base + maxPriorityFeePerGas
      return {
        maxFeePerGas: uncapped > maxFeeCap ? maxFeeCap : uncapped,
        maxPriorityFeePerGas,
      }
    },

    async checkKeeperBalance(): Promise<void> {
      const balance = await publicClient.getBalance({ address: account.address })
      if (balance >= warnBalance) {
        lastBalanceAlertAt = Number.NEGATIVE_INFINITY
        return
      }
      // Below the warn line: throttle BOTH the console line and the Telegram
      // alert to the cooldown, so a persistently-low balance logs periodically
      // rather than every poll.
      const t = now()
      if (t - lastBalanceAlertAt < BALANCE_ALERT_COOLDOWN_MS) return
      lastBalanceAlertAt = t
      botWarn(
        `[hedger-bot] keeper balance low: ${formatEther(balance)} ETH < ` +
          `${config.KEEPER_BALANCE_WARN_ETH} ETH warn (top up to ${config.MIN_KEEPER_BALANCE_ETH} ETH)`,
      )
      await notifier.notify(
        `⛽️ keeper ${account.address} is low on gas: ${formatEther(balance)} ETH ` +
          `(warn below ${config.KEEPER_BALANCE_WARN_ETH} ETH; top up to ${config.MIN_KEEPER_BALANCE_ETH} ETH) — ` +
          `hedging will halt when it hits zero`,
      )
    },
  }
}
