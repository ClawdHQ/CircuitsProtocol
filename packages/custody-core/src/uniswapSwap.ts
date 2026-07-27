import { createPublicClient, createWalletClient, parseAbi, formatUnits } from "viem";
import { viemChainFor, rpcTransportFor, usdcAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";
import type { EvmSigner } from "./signingEvmAdapter.js";

// Real Uniswap V3 deployments for ClawdHQ's own MockUSDC <-> WETH pair, individually verified
// on-chain before this was wired (a direct QuoterV2.quoteExactInputSingle call against live
// liquidity, not just "a contract is deployed here") — see agentSpendActions.ts's
// swapAgentWalletUsdcForWeth for why this exists at all: skills (SkillInvocation) have no code
// path to an AgentWallet's private key by design, so a real value-moving swap needed its own
// hardcoded action, the same way POST_JOB/X402_PAYMENT already are.
//
// Only these two chains: every DEX aggregator checked when this was built (1inch, Jupiter, CoW)
// had dropped testnet support entirely, which is why ClawdHQ's own custodied wallets — which
// only exist on testnets — had no chain in common with any of them. Uniswap's official Sepolia
// and Base Sepolia deployments turned out to have real, actively-traded liquidity specifically
// for ClawdHQ's own USDC token (confirmed live 2026-07-11: non-zero pool liquidity at multiple
// fee tiers, and a real non-degenerate quote for a 10 USDC trade on each). BSC_TESTNET/
// ARC_TESTNET aren't included here — unverified, not assumed absent (Uniswap doesn't officially
// target BNB Chain, and Arc is too new to expect a deployment yet).
type SwapSupportedChain = "BASE_SEPOLIA" | "ETH_SEPOLIA";

function isSwapSupportedChain(chain: EvmPrismaChain): chain is SwapSupportedChain {
  return chain === "BASE_SEPOLIA" || chain === "ETH_SEPOLIA";
}

interface UniswapDeployment {
  weth: `0x${string}`;
  quoterV2: `0x${string}`;
  swapRouter02: `0x${string}`;
  /** The fee tier (hundredths of a bip) with the deepest verified liquidity for ClawdHQ's own
   * USDC/WETH pair on this chain — independently the best tier per chain, since each pool was
   * seeded separately and there's no reason to expect the same tier wins on both. */
  feeTier: number;
}

const UNISWAP_DEPLOYMENTS: Record<SwapSupportedChain, UniswapDeployment> = {
  BASE_SEPOLIA: {
    weth: "0x4200000000000000000000000000000000000006",
    quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    feeTier: 500,
  },
  ETH_SEPOLIA: {
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    feeTier: 10000,
  },
};

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

// QuoterV2.quoteExactInputSingle — confirmed against the deployed bytecode's verified ABI
// (BaseScan), not just docs: 5-field input tuple, 4-field output (no `deadline` anywhere here).
const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "address", name: "tokenIn" },
          { type: "address", name: "tokenOut" },
          { type: "uint256", name: "amountIn" },
          { type: "uint24", name: "fee" },
          { type: "uint160", name: "sqrtPriceLimitX96" },
        ],
      },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160", name: "sqrtPriceX96After" },
      { type: "uint32", name: "initializedTicksCrossed" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

// SwapRouter02.exactInputSingle — SwapRouter02 (unlike the original ISwapRouter) dropped
// `deadline` from this struct entirely; confirmed against the verified on-chain ABI, not
// assumed from the original router's shape.
const SWAP_ROUTER_02_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "address", name: "tokenIn" },
          { type: "address", name: "tokenOut" },
          { type: "uint24", name: "fee" },
          { type: "address", name: "recipient" },
          { type: "uint256", name: "amountIn" },
          { type: "uint256", name: "amountOutMinimum" },
          { type: "uint160", name: "sqrtPriceLimitX96" },
        ],
      },
    ],
    outputs: [{ type: "uint256", name: "amountOut" }],
  },
] as const;

const SLIPPAGE_BPS = 100n; // 1% — applied to the live quote to set amountOutMinimum.

export interface SwapResult {
  txHashOrRef: string;
  amountInUsdc: string;
  amountOutWeth: string;
}

/** Swaps a custodied EVM wallet's USDC for WETH via a real Uniswap V3 pool. Gets a live quote
 * first and derives `amountOutMinimum` from it (SLIPPAGE_BPS) — an unprotected
 * `amountOutMinimum: 0` would let the swap execute at any price, including a sandwiched one.
 * Approves the router for exactly `amountIn` (never an unlimited allowance) only when the
 * existing allowance is insufficient, and waits for that approval to actually mine before
 * submitting the swap — so a failed or underpriced approval surfaces as its own clear error
 * instead of an opaque swap revert. */
export async function swapUsdcForWeth(chain: EvmPrismaChain, signer: EvmSigner, amountIn: bigint): Promise<SwapResult> {
  if (!isSwapSupportedChain(chain)) {
    throw new Error(`Swapping isn't wired up for ${chain} yet — only Base Sepolia and Ethereum Sepolia have verified Uniswap liquidity for ClawdHQ's USDC.`);
  }
  const deployment = UNISWAP_DEPLOYMENTS[chain];
  const viemChain = viemChainFor(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: rpcTransportFor(chain) });
  const walletClient = createWalletClient({ account: signer.account, chain: viemChain, transport: signer.transport });
  const usdcAddress = usdcAddressFor(chain);

  const balance = await publicClient.readContract({ address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [signer.address] });
  if (balance < amountIn) {
    throw new Error(`Wallet USDC balance (${formatUnits(balance, 6)}) is below the requested swap amount (${formatUnits(amountIn, 6)}).`);
  }

  const { result: quote } = await publicClient.simulateContract({
    address: deployment.quoterV2,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: usdcAddress, tokenOut: deployment.weth, amountIn, fee: deployment.feeTier, sqrtPriceLimitX96: 0n }],
  });
  const [quotedAmountOut] = quote;
  const amountOutMinimum = (quotedAmountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const allowance = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [signer.address, deployment.swapRouter02],
  });
  if (allowance < amountIn) {
    const approveTxHash = await walletClient.writeContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [deployment.swapRouter02, amountIn],
      account: signer.account,
      chain: viemChain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (receipt.status !== "success") throw new Error(`Approve transaction ${approveTxHash} reverted on-chain.`);

    // A mined receipt is confirmation the *chain* has the approval, not that this specific
    // publicClient's RPC endpoint does — a load-balanced free public endpoint (no
    // read-your-writes guarantee across its own backend nodes) can still serve a stale
    // `allowance()` read for a few seconds after the receipt it itself just returned. Hit
    // exactly this in practice: the very next exactInputSingle call reverted with "STF" against
    // one node, while a fresh readContract moments later — and the identical swap call retried
    // seconds later — both succeeded, with nothing about the approve or its args at fault.
    // Re-polling the read (not just retrying the swap blindly) confirms the specific fact this
    // call depends on before spending gas on a swap attempt likely to fail the same way.
    for (let attempt = 0; ; attempt++) {
      const confirmedAllowance = await publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [signer.address, deployment.swapRouter02],
      });
      if (confirmedAllowance >= amountIn) break;
      if (attempt >= 5) {
        throw new Error(`Approve ${approveTxHash} was mined but this RPC endpoint still doesn't reflect a sufficient allowance after retrying — try again shortly.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const swapTxHash = await walletClient.writeContract({
    address: deployment.swapRouter02,
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: usdcAddress,
        tokenOut: deployment.weth,
        fee: deployment.feeTier,
        recipient: signer.address,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
    account: signer.account,
    chain: viemChain,
  });

  return { txHashOrRef: swapTxHash, amountInUsdc: formatUnits(amountIn, 6), amountOutWeth: formatUnits(quotedAmountOut, 18) };
}
