import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parse } from 'dotenv'
import { type Address, getAddress } from 'viem'

import { parseHedgerBotConfig } from '../../src/config'
import { readSecureJson, readSecureText } from '../../src/runtime/secureFile'
import { assertProductionEligibleConfig } from '../../src/security/productionProfile'
import { keystoreV3Schema } from '../../src/utils/keystore'

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const KEYSTORE_FILENAME = 'bot-keystore.json'
const PASSPHRASE_FILENAME = 'bot-keystore-passphrase'
const FORBIDDEN_INSTANCE_KEYS = [
  'BOT_PRIVATE_KEY',
  'BOT_KEYSTORE_PASSPHRASE',
  'BOT_KEYSTORE_PATH',
  'BOT_KEYSTORE_PASSPHRASE_FILE',
  'HEDGER_STATE_DIR',
] as const

export interface MultiInstanceIdentity {
  name: string
  signerAddress: Address
  chainId: number
  safeAddress: Address
  poolAddress: Address
  mode: 'dry-run' | 'live'
}

export interface MultiInstanceCheck {
  sourceSha: string
  instances: MultiInstanceIdentity[]
}

function readEnvFile(target: string): NodeJS.ProcessEnv {
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 128 * 1024) {
    throw new Error(`${path.basename(target)} is not a valid regular configuration file`)
  }
  return parse(readFileSync(target))
}

function sourceSha(opsDirectory: string): string {
  const env = readEnvFile(path.join(opsDirectory, '.env'))
  const value = env.SOURCE_SHA
  if (!value || !SOURCE_SHA_PATTERN.test(value)) {
    throw new Error('SOURCE_SHA must be the full lowercase 40-character reviewed commit')
  }
  return value
}

function instanceDirectories(opsDirectory: string): string[] {
  const directories = readdirSync(opsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(opsDirectory, entry.name))
    .filter((directory) => {
      try {
        return readdirSync(directory).includes('hedger.env')
      } catch {
        return false
      }
    })
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  if (directories.length === 0) {
    throw new Error('no instance directories containing hedger.env were found')
  }
  return directories
}

function assertNoForbiddenKeys(env: NodeJS.ProcessEnv, instanceName: string): void {
  const forbidden = FORBIDDEN_INSTANCE_KEYS.filter((key) => env[key] !== undefined)
  if (forbidden.length > 0) {
    throw new Error(`${instanceName}: forbidden configuration keys: ${forbidden.join(', ')}`)
  }
}

function readSignerAddress(keystorePath: string): Address {
  const keystore = readSecureJson(keystorePath, keystoreV3Schema, {
    maxBytes: 16_384,
    invalid: 'throw',
  })
  if (!keystore) throw new Error('encrypted keystore is missing')
  return getAddress(`0x${keystore.address}`)
}

function checkInstance(directory: string): MultiInstanceIdentity {
  const name = path.basename(directory)
  const env = readEnvFile(path.join(directory, 'hedger.env'))
  assertNoForbiddenKeys(env, name)

  const keystorePath = path.join(directory, KEYSTORE_FILENAME)
  const passphrasePath = path.join(directory, PASSPHRASE_FILENAME)
  const signerAddress = readSignerAddress(keystorePath)
  readSecureText(passphrasePath, 4_096)

  const config = parseHedgerBotConfig({
    ...env,
    BOT_KEYSTORE_PATH: keystorePath,
    BOT_KEYSTORE_PASSPHRASE_FILE: passphrasePath,
  })
  assertProductionEligibleConfig(config)
  return {
    name,
    signerAddress,
    chainId: config.CHAIN_ID,
    safeAddress: config.SAFE_ADDRESS,
    poolAddress: config.POOL_ADDRESS,
    mode: config.DRY_RUN ? 'dry-run' : 'live',
  }
}

function normalizedAddress(address: Address): string {
  return address.toLowerCase()
}

function assertUniqueInstances(instances: MultiInstanceIdentity[]): void {
  const signers = new Map<string, string>()
  const portfolios = new Map<string, string>()
  for (const instance of instances) {
    const signer = normalizedAddress(instance.signerAddress)
    const existingSigner = signers.get(signer)
    if (existingSigner) {
      throw new Error(
        `${instance.name}: signer address duplicates ${existingSigner}; every instance needs its own signer`,
      )
    }
    signers.set(signer, instance.name)

    const portfolio = [
      instance.chainId.toString(),
      normalizedAddress(instance.safeAddress),
      normalizedAddress(instance.poolAddress),
    ].join(':')
    const existingPortfolio = portfolios.get(portfolio)
    if (existingPortfolio) {
      throw new Error(
        `${instance.name}: chain+Safe+pool duplicates ${existingPortfolio}; only one active strategy may own a portfolio`,
      )
    }
    portfolios.set(portfolio, instance.name)
  }
}

/** Validate an operations directory without decrypting keys or making network calls. */
export function checkMultiInstanceDirectory(target: string): MultiInstanceCheck {
  const opsDirectory = path.resolve(target)
  const reviewedSourceSha = sourceSha(opsDirectory)
  const instances = instanceDirectories(opsDirectory).map(checkInstance)
  assertUniqueInstances(instances)
  return { sourceSha: reviewedSourceSha, instances }
}
