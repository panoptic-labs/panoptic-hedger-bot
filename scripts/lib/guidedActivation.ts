import type { Address } from 'viem'

import type { HedgerBotConfig } from '../../src/config'
import {
  type ActivationMarker,
  buildActivationEvidence,
  buildActivationMarker,
  writeActivation,
} from '../../src/runtime/activation'
import { clearDeactivation } from '../../src/runtime/deactivation'
import { runHedgeInspection } from '../inspectHedge'
import { runDoctorChecks } from './diagnostics/checks'
import { buildDiagnosticsContext } from './diagnostics/context'
import { renderDoctor } from './diagnostics/render'
import { updateEnvFile } from './envFile'
import type { Prompter } from './prompts'
import { renderReadinessReceipt } from './readinessReceipt'

export function buildActivationCandidate(
  config: HedgerBotConfig,
  sfpmEnabled: boolean,
): HedgerBotConfig {
  return {
    ...config,
    SFPM_SWAP_ENABLED: config.SFPM_SWAP_PROVISIONED && sfpmEnabled,
    DRY_RUN: false,
  }
}

export type GuidedActivationResult = 'activated' | 'cancelled' | 'failed'

export function buildReadOnlyActivationCandidate(config: HedgerBotConfig): HedgerBotConfig {
  if (config.DRY_RUN) {
    throw new Error(
      'read-only-config activation requires DRY_RUN=false; update hedger.env and restart before activating',
    )
  }
  return buildActivationCandidate(config, config.SFPM_SWAP_ENABLED)
}

export function persistGuidedActivation(args: {
  marker: ActivationMarker
  envPath: string
  sfpmEnabled: boolean
  readOnlyConfig: boolean
}): void {
  writeActivation(args.marker)
  if (!args.readOnlyConfig) {
    // The marker is written first while the existing .env is still dry-run.
    // If this update fails, startup remains dry despite the marker.
    updateEnvFile(args.envPath, {
      SFPM_SWAP_ENABLED: args.sfpmEnabled,
      DRY_RUN: false,
    })
  }
  clearDeactivation()
}

export async function runGuidedActivation(args: {
  config: HedgerBotConfig
  envPath: string
  prompter: Prompter
  readOnlyConfig?: boolean
}): Promise<GuidedActivationResult> {
  const { config, envPath, prompter, readOnlyConfig = false } = args
  let candidate: HedgerBotConfig
  let sfpmEnabled: boolean
  if (readOnlyConfig) {
    try {
      candidate = buildReadOnlyActivationCandidate(config)
      sfpmEnabled = candidate.SFPM_SWAP_ENABLED
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'read-only activation rejected')
      return 'failed'
    }
  } else {
    sfpmEnabled = config.SFPM_SWAP_PROVISIONED
      ? await prompter.confirm(
          `Allow the reviewed SFPM route when it saves at least ` +
            `${config.SFPM_SWAP_MIN_SAVINGS_BPS} bps?`,
          config.SFPM_SWAP_ENABLED,
        )
      : false
    candidate = buildActivationCandidate(config, sfpmEnabled)
  }

  console.log('\nStep 1/3 — verifying configuration and on-chain permissions')
  const ctx = await buildDiagnosticsContext(candidate)
  const results = await runDoctorChecks(ctx)
  if (!renderDoctor(results)) {
    console.error('Activation stopped. Run the remedy shown beside each failed check.')
    return 'failed'
  }
  if (!ctx.botAddress) {
    throw new Error('preflight did not resolve the bot public address; refusing activation')
  }

  console.log('\nStep 2/3 — running one read-only hedge inspection')
  const inspection = await runHedgeInspection(candidate)

  console.log('\nStep 3/3 — review the live safety boundary')
  renderSafetyBoundary(candidate, ctx.botAddress)
  const confirmed = await prompter.confirm(
    `Activate live hedging for Safe ${candidate.SAFE_ADDRESS}?`,
    false,
  )
  if (!confirmed) {
    console.log('Activation cancelled. Configuration remains dry-run and no marker was written.')
    return 'cancelled'
  }

  const evidence = await buildActivationEvidence(ctx.publicClient, candidate)
  persistGuidedActivation({
    marker: buildActivationMarker(
      candidate,
      ctx.botAddress,
      evidence,
      true,
      new Date().toISOString(),
    ),
    envPath,
    sfpmEnabled,
    readOnlyConfig,
  })
  renderReadinessReceipt(candidate, ctx.botAddress, inspection)
  console.log(
    readOnlyConfig
      ? 'Activation marker written. Restart this Compose service before checking health.'
      : 'Start (or restart) with `pnpm start`.',
  )
  return 'activated'
}

function renderSafetyBoundary(config: HedgerBotConfig, botAddress: Address): void {
  console.log(`\nSafe ${config.SAFE_ADDRESS}`)
  console.log(`Bot  ${botAddress}`)
  console.log('\nThe bot can:')
  console.log('  ✓ mint and burn loan-only hedge positions')
  if (config.SFPM_SWAP_ENABLED) {
    console.log('  ✓ use the reviewed SFPM route when it clears the savings threshold')
  }
  console.log('  ✓ return assets only to this Safe')
  console.log('\nThe bot cannot:')
  console.log('  ✗ withdraw Safe funds')
  console.log('  ✗ mint or modify user option positions')
  console.log('  ✗ become a Safe owner')
  console.log('  ✗ make arbitrary contract calls')
}
