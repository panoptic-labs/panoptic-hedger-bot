import { formatUnits } from 'viem'

import type { HedgeExecutionResult } from '../executor/types'
import type { HedgePlan } from '../hedge/decision'
import { sanitizeError, sanitizeText } from '../utils/sanitize'

/** The sizing-token frame netDelta/H/H* are denominated in, for display. */
export interface VaultAsset {
  decimals: number
  symbol: string
}

/**
 * Format a completed hedge action into a single, visually identifiable message
 * used BOTH for the console log and the Telegram alert (identical content). Only
 * emitted when an action actually fired, so it's easy to spot amid poll noise.
 */
export function formatCycleSummary(
  plan: HedgePlan,
  result: HedgeExecutionResult,
  label: string,
  vaultAsset: VaultAsset,
): string {
  const amt = (v: bigint) => `${formatUnits(v, vaultAsset.decimals)} ${vaultAsset.symbol}`
  const tag = result.dryRun ? '🟡 HEDGE (dry-run)' : '🟢 HEDGE EXECUTED'
  const trg = [
    plan.triggers.drift ? 'drift' : null,
    plan.triggers.overCap ? 'over-cap' : null,
    plan.triggers.signFlip ? 'sign-flip' : null,
  ].filter(Boolean)
  const lines = [
    `━━━━━━ ${tag} ━━━━━━`,
    `🤖 ${label} · action: ${plan.action}`,
    `Δ netDelta ${amt(plan.netDelta)}   drift ${plan.driftBps}bps`,
    `   hedge H ${amt(plan.H)} → target H* ${amt(plan.Hstar)}`,
    `   triggers: ${trg.length ? trg.join(', ') : 'none'}`,
  ]
  if (result.openedTokenId !== null) lines.push(`🟩 opened: ${result.openedTokenId}`)
  if (result.closedTokenIds.length > 0) lines.push(`🟥 closed: ${result.closedTokenIds.join(', ')}`)
  if (result.transactionHash) lines.push(`🔗 tx: ${result.transactionHash}`)
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━')
  return lines.join('\n')
}

/** Format a skipped cycle (unsafe / stale) into a Telegram message. */
export function formatSkip(label: string, reasons: string[]): string {
  return sanitizeText(`⚠️ hedger-bot ${label} — skipped hedging: ${reasons.join('; ')}`)
}

/** Format an error into a Telegram message. */
export function formatError(label: string, error: unknown): string {
  return sanitizeText(`❌ hedger-bot ${label} — cycle error: ${sanitizeError(error)}`)
}
