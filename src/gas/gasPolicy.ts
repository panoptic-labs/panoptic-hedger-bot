import type { Account, PublicClient } from 'viem'
import { formatEther, formatUnits } from 'viem'

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
  baseFeeGwei: string
  capGwei: string
  /** True the first time a deferral streak starts (rate-limits skip alerts). */
  shouldNotifySkip: boolean
}

export interface GasPolicy {
  /** Gate a pending hedge on the current basefee. */
  assess(urgent: boolean): Promise<GasAssessment>
  /**
   * Fee-cap overrides for a send. Returns undefined on pre-EIP-1559 chains
   * (no basefee), letting the wallet client fall back to its own estimation.
   * `urgent` lifts the tip to at least URGENT_PRIORITY_FEE_GWEI.
   */
  fees(opts?: { urgent?: boolean }): Promise<GasFees | undefined>
  /**
   * Replacement fees for a stuck send: elementwise max of a fresh estimate and
   * prev x 1.125 (geth requires >=10% on BOTH fields). Returns null once the
   * bumped maxFeePerGas would exceed MAX_FEE_GWEI — stop bumping, keep waiting.
   */
  bumped(prev: GasFees, opts?: { urgent?: boolean }): Promise<GasFees | null>
  /** Alert (rate-limited) when the keeper EOA runs low on gas money. */
  checkKeeperBalance(): Promise<void>
}

export interface GasPolicyConfig {
  MAX_FEE_GWEI: bigint
  MAX_PRIORITY_FEE_GWEI: bigint
  URGENT_PRIORITY_FEE_GWEI: bigint
  HEDGE_MAX_BASE_FEE_GWEI: bigint
  URGENT_MAX_BASE_FEE_GWEI: bigint
  MIN_KEEPER_BALANCE_ETH: bigint
  KEEPER_BALANCE_WARN_ETH: bigint
}

export interface GasPolicyDeps {
  publicClient: PublicClient
  account: Account
  notifier: Notifier
  config: GasPolicyConfig
  /** Injectable clock for tests. */
  now?: () => number
}

const SKIP_ALERT_COOLDOWN_MS = 30 * 60 * 1000
const BALANCE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000

export function createGasPolicy(deps: GasPolicyDeps): GasPolicy {
  const { publicClient, account, notifier, config } = deps
  const now = deps.now ?? Date.now

  const maxFeeCap = config.MAX_FEE_GWEI
  const priorityCap = config.MAX_PRIORITY_FEE_GWEI
  const urgentPriorityFloor = config.URGENT_PRIORITY_FEE_GWEI
  // Only warn once the balance falls below this (defaults below the target
  // MIN_KEEPER_BALANCE_ETH, so routine balances above the warn line don't spam
  // the log every poll).
  const warnBalance = config.KEEPER_BALANCE_WARN_ETH

  // -Infinity = "never alerted", so the first breach always alerts even at t=0.
  let lastSkipAlertAt = Number.NEGATIVE_INFINITY
  let lastBalanceAlertAt = Number.NEGATIVE_INFINITY

  async function baseFee(): Promise<bigint | null> {
    const block = await publicClient.getBlock({ blockTag: 'latest' })
    return block.baseFeePerGas ?? null
  }

  // Lexical (not a method) so `bumped` can call it without relying on dynamic
  // `this` — the policy's functions are passed around as detached callbacks.
  async function fees(opts?: { urgent?: boolean }): Promise<GasFees | undefined> {
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
    let maxPriorityFeePerGas = estimated > ceil ? ceil : estimated
    // Urgent hedges must land NOW: lift the tip to the urgent floor even past
    // the routine ceiling (an RPC estimating ~0 during a spike would otherwise
    // leave the tx unprioritised exactly when it matters). Only the fee cap
    // bounds it.
    if (opts?.urgent && maxPriorityFeePerGas < urgentPriorityFloor) {
      maxPriorityFeePerGas = urgentPriorityFloor > maxFeeCap ? maxFeeCap : urgentPriorityFloor
    }
    // Standard headroom: 2x current basefee + tip, hard-clamped to the fee cap.
    const uncapped = 2n * base + maxPriorityFeePerGas
    return {
      maxFeePerGas: uncapped > maxFeeCap ? maxFeeCap : uncapped,
      maxPriorityFeePerGas,
    }
  }

  return {
    async assess(urgent: boolean): Promise<GasAssessment> {
      const base = await baseFee()
      const cap = urgent ? config.URGENT_MAX_BASE_FEE_GWEI : config.HEDGE_MAX_BASE_FEE_GWEI
      // No basefee (pre-1559 chain): the deferral gate can't apply.
      const proceed = base === null || base <= cap
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
        baseFeeGwei: base === null ? '0' : formatUnits(base, 9),
        capGwei: formatUnits(cap, 9),
        shouldNotifySkip,
      }
    },

    fees,

    async bumped(prev: GasFees, opts?: { urgent?: boolean }): Promise<GasFees | null> {
      // Fresh estimate tracks a moving basefee; prev x 1.125 satisfies geth's
      // >=10% replacement minimum on both fields. Take the max of each.
      const fresh = await fees(opts)
      let maxFeePerGas = (prev.maxFeePerGas * 1125n) / 1000n
      if (fresh && fresh.maxFeePerGas > maxFeePerGas) maxFeePerGas = fresh.maxFeePerGas
      let maxPriorityFeePerGas = (prev.maxPriorityFeePerGas * 1125n) / 1000n
      if (fresh && fresh.maxPriorityFeePerGas > maxPriorityFeePerGas) {
        maxPriorityFeePerGas = fresh.maxPriorityFeePerGas
      }
      if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas
      if (maxFeePerGas > maxFeeCap) return null
      return { maxFeePerGas, maxPriorityFeePerGas }
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
          `${formatEther(config.KEEPER_BALANCE_WARN_ETH)} ETH warn ` +
          `(top up to ${formatEther(config.MIN_KEEPER_BALANCE_ETH)} ETH)`,
      )
      await notifier.notify(
        `⛽️ keeper ${account.address} is low on gas: ${formatEther(balance)} ETH ` +
          `(warn below ${formatEther(config.KEEPER_BALANCE_WARN_ETH)} ETH; ` +
          `top up to ${formatEther(config.MIN_KEEPER_BALANCE_ETH)} ETH) — ` +
          `hedging will halt when it hits zero`,
      )
    },
  }
}
