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

/** Format a deleverage stage result for the console + Telegram (identical). */
export function formatDeleverageSummary(params: {
  label: string
  stage: 'loans' | 'options' | 'rehedge'
  dryRun: boolean
  bufferBps: bigint
  triggerMarginBps: bigint
  burnedTokenIds: bigint[]
  transactionHash?: string | null
  projectedBufferBps?: bigint | null
  burnedAll?: boolean
}): string {
  const tag = params.dryRun ? '🟡 DELEVERAGE (dry-run — would burn)' : '🟥 DELEVERAGE EXECUTED'
  const stageLabel =
    params.stage === 'loans'
      ? 'hedge loans'
      : params.stage === 'rehedge'
        ? 're-hedge (loan role)'
        : 'options'
  const lines = [
    `━━━━━━ ${tag} ━━━━━━`,
    `🚨 ${params.label} · stage: ${stageLabel}`,
    `margin buffer ${params.bufferBps}bps (trigger ${params.triggerMarginBps}bps)`,
    `🟥 ${params.stage === 'rehedge' ? 'adjusting' : 'burning'}: ${
      params.burnedTokenIds.length ? params.burnedTokenIds.join(', ') : 'none'
    }`,
  ]
  if (params.projectedBufferBps !== undefined && params.projectedBufferBps !== null) {
    lines.push(`   projected margin buffer after close+rehedge: ${params.projectedBufferBps}bps`)
  }
  if (params.burnedAll) lines.push('   ⚠️ no subset reached target — burning ALL options')
  if (params.transactionHash) lines.push(`🔗 tx: ${params.transactionHash}`)
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━')
  return sanitizeText(lines.join('\n'))
}

/** CRITICAL page: still at risk after all deleverage stages. */
export function formatDeleverageExhausted(label: string, bufferBps: bigint): string {
  return sanitizeText(
    `🆘 CRITICAL hedger-bot ${label} — account STILL at risk after deleveraging ` +
      `(margin buffer ${bufferBps}bps). Manual intervention required.`,
  )
}

/** Format a skipped cycle (unsafe / stale) into a Telegram message. */
export function formatSkip(label: string, reasons: string[]): string {
  return sanitizeText(`⚠️ hedger-bot ${label} — skipped hedging: ${reasons.join('; ')}`)
}

/** Format an error into a Telegram message. */
export function formatError(label: string, error: unknown): string {
  return sanitizeText(`❌ hedger-bot ${label} — cycle error: ${sanitizeError(error)}`)
}
