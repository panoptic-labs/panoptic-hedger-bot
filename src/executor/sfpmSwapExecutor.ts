import {
  type SfpmSwapKind,
  buildSfpmSwapCalldata,
  buildSfpmSwapPlan,
  parsePanopticError,
} from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem'
import { encodeFunctionData } from 'viem'

import { type SafeWalletBalances, readSafeWalletBalances } from '../hedge/walletBalances'
import { assertSafeCanReceiveErc1155 } from '../safe/erc1155Receiver'
import type { RolesExecutor } from '../safe/rolesExecutor'
import { type MultiSendCall, encodeMultiSend } from './multiSend'

/** ERC4626 CollateralTracker legs. `deposit` is payable — a native-ETH CT deposits by value. */
const collateralTrackerAbi = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: 'positionIdList', type: 'uint256[]' },
      { name: 'usePremiaAsCollateral', type: 'bool' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const

/** WETH9 wrap/unwrap. */
const weth9Abi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const

/** The collateral behind one v3-swap-pool token. */
export interface SwapSideCollateral {
  /** CollateralTracker whose underlying corresponds to this swap token. */
  collateralTracker: Address
  /** Options-pool collateral asset; zero address denotes native ETH. */
  asset: Address
  /** True when the collateral asset is native ETH (this swap token is WETH). */
  native: boolean
}

export interface SfpmSwapExecutorDeps {
  publicClient: PublicClient
  safeAddress: Address
  rolesExecutor: RolesExecutor
  /** The v3 SFPM the swap runs through. */
  sfpmAddress: Address
  /** The cheaper Uniswap pool to swap in (the SFPM poolKey's underlying pool). */
  swapPoolAddress: Address
  /** Resolved SFPM poolId for {@link swapPoolAddress}. */
  swapPoolId: bigint
  /** Collateral mapping for the v3 pool's token0 / token1 (address order). */
  token0Collateral: SwapSideCollateral
  token1Collateral: SwapSideCollateral
  /** WETH9 address — required when either side is native ETH. */
  weth9?: Address
  /** Slippage band (bps): both the swap tick band and the deposit floor haircut. */
  slippageBps: bigint
  multiSendCallOnly: Address
  /** When true, simulate via eth_call instead of sending. */
  dryRun: boolean
  /** Injectable wallet reader for deterministic tests. */
  walletBalanceReader?: () => Promise<SafeWalletBalances>
}

export interface SfpmSwapRequest {
  /** Sell the v3 pool's token0 for token1 (`true`) or token1 for token0 (`false`). */
  sellToken0: boolean
  kind: SfpmSwapKind
  /** Exact input amount (the hedger does not support exact-output recovery). */
  amount: bigint
  /**
   * Expected output of the swap (the coordinator's QuoterV2 quote). Used to set
   * the `deposit(minOut)` floor — the executor does not re-quote (the SFPM-multicall
   * simulation needs the Safe to hold the input token, which it doesn't until the
   * batch's own withdraw leg runs).
   */
  expectedAmountOut: bigint
  /** Current tick of the swap pool (slot0). */
  currentTick: number
  /**
   * Complete Panoptic position list at the moment CT.withdraw executes. The
   * solvency-aware withdrawal overload requires this whenever positions are open.
   */
  positionIdList: bigint[]
}

export interface SfpmSwapExecutionResult {
  transactionHash: Hex | null
  receipt: TransactionReceipt | null
  amountIn: bigint
  amountOut: bigint
  dryRun: boolean
}

export interface WalletRedepositResult {
  transactionHash: Hex | null
  receipt: TransactionReceipt | null
  depositedToken0: bigint
  depositedToken1: bigint
  dryRun: boolean
}

/**
 * Off-venue swap executor: rebalances collateral between the two CollateralTrackers
 * by swapping through the SFPM in a cheaper Uniswap v3 pool, aggregated in one Safe
 * MultiSend routed via the Zodiac Roles modifier. When a collateral asset is native
 * ETH, the batch wraps/unwraps around the swap (the v3 pool trades WETH):
 *
 *   CT(in).withdraw(max(amountIn-walletBalance,0), safe, safe, positionIdList, false)
 *   [ WETH9.deposit{value: nativeAmountNeeded} ]     // only if input side is native
 *   → SFPM.multicall([mint, burn])                  // the swap
 *   [ WETH9.withdraw(minOut) ]                      // only if output side is native
 *   → CT(out).deposit(minOut, safe [, value])       // value only for a native CT
 *
 * Loose Safe balances fund the input before any CT withdrawal. The
 * `deposit(minOut)` (and the native unwrap) are hard on-chain floors: if the
 * swap delivered less than `minOut`, the whole MultiSend reverts atomically.
 */
export function createSfpmSwapExecutor(deps: SfpmSwapExecutorDeps) {
  const {
    publicClient,
    safeAddress,
    rolesExecutor,
    sfpmAddress,
    swapPoolAddress,
    swapPoolId,
    token0Collateral,
    token1Collateral,
    weth9,
    slippageBps,
    multiSendCallOnly,
    dryRun,
    walletBalanceReader,
  } = deps

  const BPS = 10_000n

  async function readWalletBalances(): Promise<SafeWalletBalances> {
    if (walletBalanceReader) return walletBalanceReader()
    return readSafeWalletBalances({
      publicClient,
      safeAddress,
      asset0: token0Collateral.asset,
      asset1: token1Collateral.asset,
      weth9,
    })
  }

  function withdrawCall(ct: Address, assets: bigint, positionIdList: bigint[]): MultiSendCall {
    return {
      to: ct,
      value: 0n,
      data: encodeFunctionData({
        abi: collateralTrackerAbi,
        functionName: 'withdraw',
        args: [assets, safeAddress, safeAddress, positionIdList, false],
      }),
    }
  }

  function depositCall(ct: Address, assets: bigint, native: boolean): MultiSendCall {
    return {
      to: ct,
      value: native ? assets : 0n, // native-ETH CT deposit is payable
      data: encodeFunctionData({
        abi: collateralTrackerAbi,
        functionName: 'deposit',
        args: [assets, safeAddress],
      }),
    }
  }

  function wrapCall(assets: bigint): MultiSendCall {
    if (weth9 === undefined) throw new Error('weth9 address required to wrap native ETH')
    return {
      to: weth9,
      value: assets,
      data: encodeFunctionData({ abi: weth9Abi, functionName: 'deposit', args: [] }),
    }
  }

  function unwrapCall(assets: bigint): MultiSendCall {
    if (weth9 === undefined) throw new Error('weth9 address required to unwrap WETH')
    return {
      to: weth9,
      value: 0n,
      data: encodeFunctionData({ abi: weth9Abi, functionName: 'withdraw', args: [assets] }),
    }
  }

  /** Build the withdraw→[wrap]→swap→[unwrap]→deposit MultiSend RolesCall for a request. */
  async function buildRolesCall(req: SfpmSwapRequest): Promise<{
    rolesCall: { to: Address; value: bigint; data: Hex; operation: 1 }
    withdrawalCall?: MultiSendCall
    amountIn: bigint
    amountOut: bigint
  }> {
    if (req.kind !== 'exactIn') throw new Error('hedger SFPM swaps must be exact-input')
    if (req.amount <= 0n) throw new Error('SFPM swap input must be positive')
    if (req.expectedAmountOut <= 0n) throw new Error('SFPM expected output must be positive')
    const plan = buildSfpmSwapPlan({
      sfpmAddress,
      poolAddress: swapPoolAddress,
      poolId: swapPoolId,
      kind: req.kind,
      zeroForOne: req.sellToken0,
      amount: req.amount,
      currentTick: req.currentTick,
      slippageBps,
    })

    // exactIn: the input is the requested amount; the output is the coordinator's
    // QuoterV2 quote (no re-quote here — see SfpmSwapRequest.expectedAmountOut).
    const amountIn = req.amount
    const amountOut = req.expectedAmountOut

    const inSide = req.sellToken0 ? token0Collateral : token1Collateral
    const outSide = req.sellToken0 ? token1Collateral : token0Collateral
    const wallet = await readWalletBalances()
    const walletIn = req.sellToken0 ? wallet.token0 : wallet.token1

    // CT.withdraw is asset-exact, so withdraw only the portion not already held
    // by the Safe. Require at least the slippage-haircut output on the way back in.
    const minOut = amountOut - (amountOut * slippageBps) / BPS

    const tokenFromWallet = walletIn.token < amountIn ? walletIn.token : amountIn
    const afterToken = amountIn - tokenFromWallet
    const nativeFromWallet =
      inSide.native && walletIn.native < afterToken
        ? walletIn.native
        : inSide.native
          ? afterToken
          : 0n
    const withdrawalAmount = afterToken - nativeFromWallet
    const withdrawalCall =
      withdrawalAmount > 0n
        ? withdrawCall(inSide.collateralTracker, withdrawalAmount, req.positionIdList)
        : undefined
    const calls: MultiSendCall[] = []
    if (withdrawalCall) calls.push(withdrawalCall)
    if (inSide.native) {
      const wrapAmount = nativeFromWallet + withdrawalAmount
      if (wrapAmount > 0n) calls.push(wrapCall(wrapAmount))
    }
    calls.push({ to: sfpmAddress, value: 0n, data: buildSfpmSwapCalldata(plan).multicallData })
    if (outSide.native) calls.push(unwrapCall(minOut))
    calls.push(depositCall(outSide.collateralTracker, minOut, outSide.native))

    return {
      rolesCall: {
        to: multiSendCallOnly,
        value: 0n,
        data: encodeMultiSend(calls),
        operation: 1, // DELEGATECALL to MultiSendCallOnly
      },
      withdrawalCall,
      amountIn,
      amountOut,
    }
  }

  /**
   * eth_call-simulate the off-venue swap MultiSend without sending. Resolves
   * when it would succeed and preserves the underlying exception on failure so
   * the caller can report whether Roles, liquidity, or collateral rejected it.
   */
  async function simulate(req: SfpmSwapRequest): Promise<void> {
    await assertSafeCanReceiveErc1155({
      publicClient,
      safeAddress,
      tokenAddress: sfpmAddress,
    })
    const { rolesCall, withdrawalCall } = await buildRolesCall(req)
    try {
      // Probe the first leg directly from the Safe before the aggregate Roles
      // simulation. MultiSend/ModuleTransactionFailed can hide the underlying
      // CollateralTracker selector; this preserves actionable errors such as
      // ExceedsMaximumRedemption when pool liquidity cannot fund this direction.
      if (withdrawalCall) {
        await publicClient.call({
          account: safeAddress,
          to: withdrawalCall.to,
          data: withdrawalCall.data,
          value: withdrawalCall.value,
        })
      }
    } catch (error) {
      const parsed = parsePanopticError(error)
      if (parsed) {
        const withdrawalError = new Error(
          `input CollateralTracker withdrawal rejected: ${parsed.errorName} — ${parsed.error.message}`,
        )
        ;(withdrawalError as { cause?: unknown }).cause = error
        throw withdrawalError
      }
      throw error
    }
    await rolesExecutor.simulate(rolesCall)
  }

  async function execute(req: SfpmSwapRequest): Promise<SfpmSwapExecutionResult> {
    const { rolesCall, amountIn, amountOut } = await buildRolesCall(req)
    if (dryRun) {
      await rolesExecutor.simulate(rolesCall)
      return { transactionHash: null, receipt: null, amountIn, amountOut, dryRun: true }
    }
    const receipt = await rolesExecutor.send(rolesCall)
    return {
      transactionHash: receipt.transactionHash,
      receipt,
      amountIn,
      amountOut,
      dryRun: false,
    }
  }

  /**
   * Sweep every loose collateral asset back into its CollateralTracker. WETH on
   * a native side is unwrapped first; both sides are deposited in one atomic
   * Roles/MultiSend transaction.
   */
  async function redepositWalletBalances(): Promise<WalletRedepositResult> {
    const balances = await readWalletBalances()
    const calls: MultiSendCall[] = []
    const appendSide = (side: SwapSideCollateral, balance: SafeWalletBalances['token0']) => {
      if (balance.total === 0n) return
      if (side.native && balance.token > 0n) calls.push(unwrapCall(balance.token))
      calls.push(depositCall(side.collateralTracker, balance.total, side.native))
    }
    appendSide(token0Collateral, balances.token0)
    appendSide(token1Collateral, balances.token1)
    if (calls.length === 0) {
      return {
        transactionHash: null,
        receipt: null,
        depositedToken0: 0n,
        depositedToken1: 0n,
        dryRun,
      }
    }
    const rolesCall = {
      to: multiSendCallOnly,
      value: 0n,
      data: encodeMultiSend(calls),
      operation: 1 as const,
    }
    if (dryRun) {
      await rolesExecutor.simulate(rolesCall)
      return {
        transactionHash: null,
        receipt: null,
        depositedToken0: balances.token0.total,
        depositedToken1: balances.token1.total,
        dryRun: true,
      }
    }
    const receipt = await rolesExecutor.send(rolesCall)
    return {
      transactionHash: receipt.transactionHash,
      receipt,
      depositedToken0: balances.token0.total,
      depositedToken1: balances.token1.total,
      dryRun: false,
    }
  }

  return { execute, simulate, readWalletBalances, redepositWalletBalances }
}
