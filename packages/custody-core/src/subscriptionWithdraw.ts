import { getDecryptedSubscriptionWallet } from "./subscriptionCustody.js";
import { isEvmPrismaChain, type EvmPrismaChain } from "./evmChainConfig.js";
import { withdrawErc20Balance, localEvmSigner, type Erc20WithdrawResult } from "./signingEvmAdapter.js";
import { isSolanaPrismaChain, type SolanaPrismaChain } from "./solanaChainConfig.js";
import { withdrawSolanaUsdcBalance } from "./signingSolanaAdapter.js";
import { type SuiPrismaChain } from "./suiChainConfig.js";
import { withdrawSuiUsdcBalance } from "./signingSuiAdapter.js";

// Sweeps a subscription's custodied wallet back to its verified owner — never a caller-supplied
// address. Callers must resolve `ownerAddress` via a verified session/ownership check first,
// same "destination comes from a verified source, never request input" shape Degen's withdrawal
// path already uses.
export async function withdrawSubscriptionWallet(
  subscriptionId: string,
  chain: EvmPrismaChain | SolanaPrismaChain | SuiPrismaChain,
  ownerAddress: string,
): Promise<Erc20WithdrawResult> {
  const wallet = await getDecryptedSubscriptionWallet(subscriptionId);
  if (!wallet) throw new Error("No wallet has been provisioned for this subscription");

  if (isEvmPrismaChain(chain)) {
    return withdrawErc20Balance(localEvmSigner(chain, wallet.privateKey), chain, ownerAddress as `0x${string}`);
  }
  if (isSolanaPrismaChain(chain)) {
    return withdrawSolanaUsdcBalance(chain, wallet.privateKey, ownerAddress);
  }
  return withdrawSuiUsdcBalance(chain, wallet.privateKey, ownerAddress);
}
