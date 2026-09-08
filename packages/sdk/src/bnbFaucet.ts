import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseUnits,
  isAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const MOCK_USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const DEFAULT_BSC_RPC = "https://data-seed-prebsc-1-s1.binance.org:8545";
export const DEFAULT_BSC_USDC_ADDRESS = "0xE17a676753e9fC58101F6cb8050309c73238a30e";
export const DEFAULT_BSC_DEPLOYER_KEY = "0x38df6054539aad5ef152dfeb9cf7dea54c85c91ba61d2f0a2902e52efef24bb3";

export interface BnbFaucetResult {
  usdcTxHash: string;
  amountUsdc: string;
  gasTxHash?: string;
  recipient: string;
}

/**
 * Funds an address or agent on BNB Chain Testnet with test USDC and tBNB gas subsidy.
 */
export async function fundBnbFaucet(recipientAddress: string): Promise<BnbFaucetResult> {
  if (!isAddress(recipientAddress)) {
    throw new Error(`Invalid recipient address for BNB faucet: ${recipientAddress}`);
  }

  const rpcUrl = process.env.BSC_TESTNET_RPC_URL || DEFAULT_BSC_RPC;
  const usdcAddress = (process.env.BSC_TESTNET_USDC_ADDRESS || DEFAULT_BSC_USDC_ADDRESS) as Address;
  const deployerKey = (process.env.EVM_DEPLOYER_PRIVATE_KEY || DEFAULT_BSC_DEPLOYER_KEY) as `0x${string}`;

  const account = privateKeyToAccount(deployerKey);
  const transport = http(rpcUrl);

  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });
  const publicClient = createPublicClient({ chain: bscTestnet, transport });

  const amountUsdcNumber = "100"; // 100 USDC per faucet request
  const amountToMint = parseUnits(amountUsdcNumber, 6);

  // 1. Mint 100 MockUSDC directly to the user/agent's wallet
  const usdcTxHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: MOCK_USDC_ABI,
    functionName: "mint",
    args: [recipientAddress as Address, amountToMint],
  });

  // 2. Check if user needs tBNB for gas (if balance < 0.002 tBNB, sponsor 0.003 tBNB)
  let gasTxHash: string | undefined;
  try {
    const balance = await publicClient.getBalance({ address: recipientAddress as Address });
    if (balance < parseUnits("0.002", 18)) {
      gasTxHash = await walletClient.sendTransaction({
        to: recipientAddress as Address,
        value: parseUnits("0.003", 18),
      });
    }
  } catch (gasErr) {
    console.warn("[BNB Faucet] Gas subsidy notice:", gasErr);
  }

  return {
    usdcTxHash,
    amountUsdc: amountUsdcNumber,
    gasTxHash,
    recipient: recipientAddress,
  };
}
