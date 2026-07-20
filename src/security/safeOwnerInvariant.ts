import type { Address, PublicClient } from 'viem'
import { getAddress } from 'viem'

const safeOwnersAbi = [
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
] as const

export class BotIsSafeOwnerError extends Error {
  constructor(botAddress: Address, safeAddress: Address) {
    super(
      `security invariant failed: bot ${getAddress(botAddress)} is an owner of Safe ` +
        `${getAddress(safeAddress)}; the bot must hold only its scoped Zodiac role`,
    )
    this.name = 'BotIsSafeOwnerError'
  }
}

export class PlannedBotSafeOwnerError extends Error {
  constructor(botAddress: Address) {
    super(
      `security invariant failed: planned setup would make bot ${getAddress(botAddress)} ` +
        'a Safe owner; the bot must hold only its scoped Zodiac role',
    )
    this.name = 'PlannedBotSafeOwnerError'
  }
}

/** Read owners through the Safe's public, side-effect-free view. */
export async function readSafeOwners(
  publicClient: PublicClient,
  safeAddress: Address,
): Promise<readonly Address[]> {
  return publicClient.readContract({
    address: safeAddress,
    abi: safeOwnersAbi,
    functionName: 'getOwners',
  })
}

/**
 * Fail closed unless the current on-chain owner set excludes the bot EOA.
 * Call this immediately before every bot-authorized transaction.
 */
export async function assertBotIsNotSafeOwner(
  publicClient: PublicClient,
  safeAddress: Address,
  botAddress: Address,
): Promise<readonly Address[]> {
  const owners = await readSafeOwners(publicClient, safeAddress)
  if (owners.some((owner) => getAddress(owner) === getAddress(botAddress))) {
    throw new BotIsSafeOwnerError(botAddress, safeAddress)
  }
  return owners
}

/** Reject a setup plan that would deliberately leave the bot as a Safe owner. */
export function assertPlannedSafeOwnerIsNotBot(safeOwner: Address, botAddress: Address): void {
  if (getAddress(safeOwner) === getAddress(botAddress)) {
    throw new PlannedBotSafeOwnerError(botAddress)
  }
}
