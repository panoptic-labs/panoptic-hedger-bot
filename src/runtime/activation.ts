import { unlinkSync } from 'node:fs'

import type { Address, Hex, PublicClient } from 'viem'
import { getAddress, keccak256, toHex } from 'viem'
import { z } from 'zod'

import type { HedgerBotConfig } from '../config'
import { deleveragerRoleKey } from '../config'
import {
  assertProductionEligibleConfig,
  isProductionEligibleConfig,
  resolveRolePolicy,
} from '../security/productionProfile'
import { runtimeDataPath } from './paths'
import { readSecureJson, writeSecureJson } from './secureFile'
import { botVersion } from './stateFile'

const ACTIVATION_SCHEMA_VERSION = 2 as const
// v4: adds the optional bot-held burn-only deleverager role to the reviewed
// profile. Bumping this invalidates existing activation markers on purpose —
// operators re-review and re-run `pnpm activate` after upgrading.
export const ACTIVATION_POLICY_VERSION = 'hedger-bot-policy-v4' as const
const MAX_ACTIVATION_BYTES = 16 * 1024
// keccak256(toHex(JSON.stringify(build<Role>DispatchConditions()))) of the
// reviewed SDK condition trees — recompute and re-review on any builder change.
const REVIEWED_LOAN_ROLE_TREE_HASH =
  '0x82a2514e569a1aa6aa09d62c2d3018e4977709e6ddb098d08a1bc3f87797785d' as const
const REVIEWED_DELEVERAGER_ROLE_TREE_HASH =
  '0x22fae33e81329375ba466b4b679de47f3dc8945cc8ede6f965f417a9640f6ea4' as const

const hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/)
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/)

const activationMarkerSchema = z
  .object({
    schemaVersion: z.literal(ACTIVATION_SCHEMA_VERSION),
    policyVersion: z.literal(ACTIVATION_POLICY_VERSION),
    releaseVersion: z.string().min(1).max(128),
    activatedAt: z.string().datetime(),
    doctorPassed: z.literal(true),
    botAddress: addressSchema,
    safeAddress: addressSchema,
    poolAddress: addressSchema,
    policyFingerprint: hex32Schema,
    codeIdentityFingerprint: hex32Schema,
    permissionManifestFingerprint: hex32Schema,
  })
  .strict()

export type ActivationMarker = z.infer<typeof activationMarkerSchema>

export interface ActivationEvidence {
  codeIdentityFingerprint: Hex
  permissionManifestFingerprint: Hex
}

function canonicalAddress(address: Address): Address {
  return getAddress(address).toLowerCase() as Address
}

function hashCanonical(value: unknown): Hex {
  return keccak256(toHex(JSON.stringify(value)))
}

/** The exact reviewed permission policy accepted for this release candidate. */
export function expectedPermissionManifestFingerprint(
  config: Pick<HedgerBotConfig, 'DELEVERAGER_ENABLED'>,
): Hex {
  return hashCanonical({
    version: 3,
    loanRoleTree: REVIEWED_LOAN_ROLE_TREE_HASH,
    deleveragerRoleTree: config.DELEVERAGER_ENABLED ? REVIEWED_DELEVERAGER_ROLE_TREE_HASH : null,
    rolePolicy: resolveRolePolicy(config),
    routerPermissions: 'none',
    loanBounds: 'not-enforced-operator-deferred-phase-2.4',
  })
}

function codeIdentityAddresses(config: HedgerBotConfig): readonly [string, Address][] {
  const entries: [string, Address | undefined][] = [
    ['safe', config.SAFE_ADDRESS],
    ['pool', config.POOL_ADDRESS],
    ['rolesModifier', config.ROLES_MODIFIER_ADDRESS],
    ['uniswapV3SignalPool', config.UNISWAP_SIGNAL_POOL_ADDRESS],
    ['uniswapV4StateView', config.UNISWAP_SIGNAL_STATE_VIEW_ADDRESS],
  ]
  return entries.flatMap(([name, address]) => (address ? [[name, address]] : []))
}

/** Bind activation to the actual runtime bytecode at every configured contract identity. */
export async function readCodeIdentityFingerprint(
  publicClient: PublicClient,
  config: HedgerBotConfig,
): Promise<Hex> {
  const identities = await Promise.all(
    codeIdentityAddresses(config).map(async ([name, address]) => {
      const code = await publicClient.getCode({ address })
      if (!code || code === '0x') throw new Error(`no bytecode at configured ${name} ${address}`)
      return [name, canonicalAddress(address), keccak256(code)] as const
    }),
  )
  return hashCanonical(identities)
}

export async function buildActivationEvidence(
  publicClient: PublicClient,
  config: HedgerBotConfig,
): Promise<ActivationEvidence> {
  return {
    codeIdentityFingerprint: await readCodeIdentityFingerprint(publicClient, config),
    permissionManifestFingerprint: expectedPermissionManifestFingerprint(config),
  }
}

/** Canonical, secret-free policy input whose hash controls live eligibility. */
export function buildActivationPolicy(
  config: HedgerBotConfig,
  botAddress: Address,
  evidence: ActivationEvidence,
): unknown {
  return {
    policyVersion: ACTIVATION_POLICY_VERSION,
    releaseVersion: botVersion(),
    chainId: config.CHAIN_ID,
    rpcUrl: config.RPC_URL,
    botAddress: canonicalAddress(botAddress),
    safeAddress: canonicalAddress(config.SAFE_ADDRESS),
    poolAddress: canonicalAddress(config.POOL_ADDRESS),
    rolesModifierAddress: canonicalAddress(config.ROLES_MODIFIER_ADDRESS),
    roleKey: config.ROLE_KEY.toLowerCase(),
    supportedProfile: 'ethereum-mainnet-single-safe-single-pool',
    rolePolicy: resolveRolePolicy(config),
    deleverager: config.DELEVERAGER_ENABLED
      ? {
          roleKey: deleveragerRoleKey(config).toLowerCase(),
          triggerMarginBps: config.DELEVERAGE_TRIGGER_MARGIN_BPS.toString(),
          targetMarginBps: config.DELEVERAGE_TARGET_MARGIN_BPS.toString(),
          slippageBps: config.DELEVERAGE_SLIPPAGE_BPS,
          cooldownMs: config.DELEVERAGE_COOLDOWN_MS,
        }
      : null,
    hedgeVenue: config.HEDGE_VENUE,
    assetIndex: config.ASSET_INDEX.toString(),
    deltaThresholdBps: config.DELTA_THRESHOLD_BPS.toString(),
    maxHedgeSlots: config.MAX_HEDGE_SLOTS,
    slippageBps: config.SLIPPAGE_BPS,
    minMarginReserveBps: config.MIN_MARGIN_RESERVE_BPS.toString(),
    builderCode: config.PANOPTIC_BUILDER_CODE ?? null,
    signal: {
      source: config.PRICE_SIGNAL_SOURCE,
      sanityMax: config.SIGNAL_TICK_SANITY_MAX,
      maxBlockAgeSeconds: config.MAX_SIGNAL_BLOCK_AGE_SECONDS,
      cexSymbol: config.CEX_SYMBOL,
      cexStaleMs: config.CEX_STALE_MS,
      cexMinFeeds: config.CEX_MIN_FEEDS,
      uniswapVersion: config.UNISWAP_SIGNAL_POOL_VERSION,
      uniswapPool: config.UNISWAP_SIGNAL_POOL_ADDRESS
        ? canonicalAddress(config.UNISWAP_SIGNAL_POOL_ADDRESS)
        : null,
      uniswapStateView: config.UNISWAP_SIGNAL_STATE_VIEW_ADDRESS
        ? canonicalAddress(config.UNISWAP_SIGNAL_STATE_VIEW_ADDRESS)
        : null,
      uniswapPoolId: config.UNISWAP_SIGNAL_POOL_ID?.toLowerCase() ?? null,
    },
    gasPolicy: {
      maxFeeGwei: config.MAX_FEE_GWEI.toString(),
      maxPriorityFeeGwei: config.MAX_PRIORITY_FEE_GWEI.toString(),
      urgentPriorityFeeGwei: config.URGENT_PRIORITY_FEE_GWEI.toString(),
      hedgeMaxBaseFeeGwei: config.HEDGE_MAX_BASE_FEE_GWEI.toString(),
      urgentMaxBaseFeeGwei: config.URGENT_MAX_BASE_FEE_GWEI.toString(),
      urgentDriftMultiplier: config.URGENT_DRIFT_MULTIPLIER,
      minKeeperBalanceEth: config.MIN_KEEPER_BALANCE_ETH.toString(),
      keeperBalanceWarnEth: config.KEEPER_BALANCE_WARN_ETH.toString(),
      receiptTimeoutMs: config.TX_RECEIPT_TIMEOUT_MS,
      bumpIntervalMs: config.TX_BUMP_INTERVAL_MS,
    },
    pollIntervalMs: config.POLL_INTERVAL_MS,
    codeIdentityFingerprint: evidence.codeIdentityFingerprint,
    permissionManifestFingerprint: evidence.permissionManifestFingerprint,
  }
}

export function activationPath(): string {
  return process.env.HEDGER_ACTIVATED_PATH ?? runtimeDataPath('.hedger-activated.json')
}

export function readActivation(): ActivationMarker | null {
  return readSecureJson(activationPath(), activationMarkerSchema, {
    maxBytes: MAX_ACTIVATION_BYTES,
    invalid: 'null',
  })
}

export function writeActivation(marker: ActivationMarker): void {
  writeSecureJson(activationPath(), activationMarkerSchema, marker)
}

export function clearActivation(): void {
  try {
    unlinkSync(activationPath())
  } catch {
    // already gone
  }
}

export function buildActivationMarker(
  config: HedgerBotConfig,
  botAddress: Address,
  evidence: ActivationEvidence,
  doctorPassed: true,
  activatedAt: string,
): ActivationMarker {
  assertProductionEligibleConfig(config)
  return {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    policyVersion: ACTIVATION_POLICY_VERSION,
    releaseVersion: botVersion(),
    activatedAt,
    doctorPassed,
    botAddress: canonicalAddress(botAddress),
    safeAddress: canonicalAddress(config.SAFE_ADDRESS),
    poolAddress: canonicalAddress(config.POOL_ADDRESS),
    policyFingerprint: hashCanonical(buildActivationPolicy(config, botAddress, evidence)),
    codeIdentityFingerprint: evidence.codeIdentityFingerprint,
    permissionManifestFingerprint: evidence.permissionManifestFingerprint,
  }
}

export function isActivated(
  config: HedgerBotConfig,
  botAddress: Address | undefined,
  evidence: ActivationEvidence | undefined,
): boolean {
  if (!botAddress || !evidence) return false
  if (!isProductionEligibleConfig(config)) return false
  const marker = readActivation()
  if (!marker) return false
  const expected = buildActivationMarker(config, botAddress, evidence, true, marker.activatedAt)
  return (
    marker.policyFingerprint === expected.policyFingerprint &&
    marker.codeIdentityFingerprint === expected.codeIdentityFingerprint &&
    marker.permissionManifestFingerprint === expected.permissionManifestFingerprint &&
    marker.releaseVersion === expected.releaseVersion
  )
}
