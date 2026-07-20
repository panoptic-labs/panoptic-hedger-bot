import 'dotenv/config'

import { type ScopeStep, rolesV2Abi } from '@panoptic-eng/sdk/zodiac'
import type { Address, Hex } from 'viem'
import { encodeFunctionData, getAddress, isAddress, isHex, size, toFunctionSelector } from 'viem'

import { sanitizeError } from '../src/utils/sanitize'
import { buildLoanOnlyDispatchConditions } from './lib/rolesScope'
import { emitSafeTransactionBuilderBatch } from './lib/safeProposal'

/**
 * Idempotently (re)scope the bot role on an already-deployed Zodiac Roles v2
 * modifier so the bot EOA can ONLY mint/burn width=0 loans via PanopticPool.dispatch.
 *
 * ⚠️  Dry-run on a fork first (see scripts/lib/rolesScope.ts banner + runbook.md).
 *
 * Required env:
 *   CHAIN_ID, SAFE_ADDRESS, ROLES_MODIFIER_ADDRESS, POOL_ADDRESS, ROLE_KEY
 *   (bytes32), BOT_ADDRESS (role member)
 */

const DISPATCH_SELECTOR = toFunctionSelector(
  'dispatch(uint256[],uint256[],uint128[],int24[3][],bool,uint256)',
)
const EXEC_OPTIONS_NONE = 0 // plain call, no value / no delegatecall

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

function addressArg(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value))
    throw new Error('invalid address in scope step')
  return getAddress(value)
}

function hexArg(value: unknown, bytes: number): Hex {
  if (typeof value !== 'string' || !isHex(value) || size(value) !== bytes) {
    throw new Error(`invalid bytes${bytes} value in scope step`)
  }
  return value
}

function dynamicHexArg(value: unknown): Hex {
  if (typeof value !== 'string' || !isHex(value)) throw new Error('invalid bytes in scope step')
  return value
}

function uint8Arg(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error('invalid uint8 in scope step')
  }
  return value
}

function conditionsArg(value: unknown) {
  if (!Array.isArray(value)) throw new Error('invalid conditions in scope step')
  return value.map((condition) => {
    if (!condition || typeof condition !== 'object') {
      throw new Error('invalid condition in scope step')
    }
    return {
      parent: uint8Arg(condition.parent),
      paramType: uint8Arg(condition.paramType),
      operator: uint8Arg(condition.operator),
      compValue: dynamicHexArg(condition.compValue),
    }
  })
}

function encodeScopeStep(step: ScopeStep): Hex {
  const args = step.args
  switch (step.functionName) {
    case 'assignRoles': {
      if (!Array.isArray(args[1]) || !Array.isArray(args[2])) throw new Error('invalid assignRoles')
      const roles = args[1].map((role) => hexArg(role, 32))
      const membership = args[2].map((memberOf) => {
        if (typeof memberOf !== 'boolean') throw new Error('invalid role membership flag')
        return memberOf
      })
      return encodeFunctionData({
        abi: rolesV2Abi,
        functionName: 'assignRoles',
        args: [addressArg(args[0]), roles, membership],
      })
    }
    case 'scopeTarget':
      return encodeFunctionData({
        abi: rolesV2Abi,
        functionName: 'scopeTarget',
        args: [hexArg(args[0], 32), addressArg(args[1])],
      })
    case 'scopeFunction':
      return encodeFunctionData({
        abi: rolesV2Abi,
        functionName: 'scopeFunction',
        args: [
          hexArg(args[0], 32),
          addressArg(args[1]),
          hexArg(args[2], 4),
          conditionsArg(args[3]),
          uint8Arg(args[4]),
        ],
      })
    case 'allowFunction':
      return encodeFunctionData({
        abi: rolesV2Abi,
        functionName: 'allowFunction',
        args: [hexArg(args[0], 32), addressArg(args[1]), hexArg(args[2], 4), uint8Arg(args[3])],
      })
    case 'setTransactionUnwrapper':
      return encodeFunctionData({
        abi: rolesV2Abi,
        functionName: 'setTransactionUnwrapper',
        args: [addressArg(args[0]), hexArg(args[1], 4), addressArg(args[2])],
      })
  }
}

async function main(): Promise<void> {
  const chainId = Number(requireEnv('CHAIN_ID'))
  const safeAddress = getAddress(requireEnv('SAFE_ADDRESS'))
  const rolesModifier = getAddress(requireEnv('ROLES_MODIFIER_ADDRESS'))
  const pool = getAddress(requireEnv('POOL_ADDRESS'))
  const roleKey = requireEnv('ROLE_KEY') as `0x${string}`
  const botAddress = getAddress(requireEnv('BOT_ADDRESS'))
  const conditions = buildLoanOnlyDispatchConditions()

  const steps: ScopeStep[] = [
    {
      name: 'assignRoles(bot)',
      functionName: 'assignRoles',
      args: [botAddress, [roleKey], [true]],
    },
    { name: 'scopeTarget(pool)', functionName: 'scopeTarget', args: [roleKey, pool] },
    {
      name: 'scopeFunction(dispatch, loan-only)',
      functionName: 'scopeFunction',
      args: [roleKey, pool, DISPATCH_SELECTOR, conditions, EXEC_OPTIONS_NONE],
    },
  ]

  const calls = steps.map((step) => ({
    description: step.name,
    policy: JSON.stringify(step.args),
    to: rolesModifier,
    value: 0n,
    data: encodeScopeStep(step),
  }))
  emitSafeTransactionBuilderBatch({
    chainId,
    safeAddress,
    name: 'Configure in-pool loan-only hedger Zodiac role',
    description:
      'Production in-pool single-target loan-only permission manifest. ' +
      'Import, inspect every call, simulate, and obtain the Safe threshold approvals.',
    calls,
  })
}

main().catch((err) => {
  console.error(sanitizeError(err))
  process.exit(1)
})
