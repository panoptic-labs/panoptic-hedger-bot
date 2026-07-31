import type { Address, PublicClient } from 'viem'
import { parseAbi, zeroAddress } from 'viem'

const balanceOfAbi = parseAbi(['function balanceOf(address account) view returns (uint256)'])

export interface SafeWalletSideBalance {
  /** ERC20 balance usable by the swap. For a native side this is WETH. */
  token: bigint
  /** Native balance belonging to this side (zero for an ERC20 collateral side). */
  native: bigint
  /** Economic balance of this collateral asset: token + native. */
  total: bigint
}

export interface SafeWalletBalances {
  token0: SafeWalletSideBalance
  token1: SafeWalletSideBalance
}

export const EMPTY_SAFE_WALLET_BALANCES: SafeWalletBalances = {
  token0: { token: 0n, native: 0n, total: 0n },
  token1: { token: 0n, native: 0n, total: 0n },
}

/** Keep 0.50% of sold-side inventory available for premiums and commissions. */
export const BALANCE_FIRST_COLLATERAL_RESERVE_BPS = 50n

/**
 * Maximum amount a balance-first swap may spend while retaining a rounded-up
 * reserve. Any positive balance keeps at least one smallest unit when the
 * reserve is nonzero.
 */
export function spendableAfterCollateralReserve(
  balance: bigint,
  reserveBps = BALANCE_FIRST_COLLATERAL_RESERVE_BPS,
): bigint {
  if (balance < 0n) throw new Error('collateral balance cannot be negative')
  if (reserveBps < 0n || reserveBps > 10_000n) {
    throw new Error('collateral reserve bps must be between 0 and 10000')
  }
  if (balance === 0n || reserveBps === 0n) return balance
  const reserve = (balance * reserveBps + 9_999n) / 10_000n
  return balance > reserve ? balance - reserve : 0n
}

export interface ReadSafeWalletBalancesDeps {
  publicClient: PublicClient
  safeAddress: Address
  asset0: Address
  asset1: Address
  /** WETH9 used to account for the wrapped portion of a native-ETH side. */
  weth9?: Address
  blockNumber?: bigint
}

/**
 * Read loose Safe balances in the options-pool token frame. Native ETH and WETH
 * are deliberately combined on the native collateral side because either form
 * can be consumed by the SFPM maintenance batch.
 */
export async function readSafeWalletBalances(
  deps: ReadSafeWalletBalancesDeps,
): Promise<SafeWalletBalances> {
  const nativeSides = [deps.asset0, deps.asset1].filter(
    (asset) => asset.toLowerCase() === zeroAddress,
  ).length
  if (nativeSides > 1) throw new Error('both collateral assets cannot be native')
  const nativeBalance =
    nativeSides === 0
      ? 0n
      : await deps.publicClient.getBalance({
          address: deps.safeAddress,
          blockNumber: deps.blockNumber,
        })

  const readSide = async (asset: Address): Promise<SafeWalletSideBalance> => {
    const native = asset.toLowerCase() === zeroAddress
    const tokenAddress = native ? deps.weth9 : asset
    if (tokenAddress === undefined) {
      return { token: 0n, native: nativeBalance, total: nativeBalance }
    }
    const token = await deps.publicClient.readContract({
      address: tokenAddress,
      abi: balanceOfAbi,
      functionName: 'balanceOf',
      args: [deps.safeAddress],
      blockNumber: deps.blockNumber,
    })
    const looseNative = native ? nativeBalance : 0n
    return { token, native: looseNative, total: token + looseNative }
  }

  const [token0, token1] = await Promise.all([readSide(deps.asset0), readSide(deps.asset1)])
  return { token0, token1 }
}
