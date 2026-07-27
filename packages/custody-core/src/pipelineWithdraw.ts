import { getDecryptedPipelineWallet } from "./pipelineCustody.js";
import { type EvmPrismaChain } from "./evmChainConfig.js";
import { withdrawErc20Balance, localEvmSigner, type Erc20WithdrawResult } from "./signingEvmAdapter.js";

// Sweeps a pipeline's custodied wallet back to its verified owner — never a caller-supplied
// address. Callers must resolve `ownerAddress` via a verified session/ownership check first,
// same shape subscriptionWithdraw.ts already uses. EVM-only, matching pipelineCustody.ts.
export async function withdrawPipelineWallet(pipelineId: string, chain: EvmPrismaChain, ownerAddress: string): Promise<Erc20WithdrawResult> {
  const wallet = await getDecryptedPipelineWallet(pipelineId);
  if (!wallet) throw new Error("No wallet has been provisioned for this pipeline");

  return withdrawErc20Balance(localEvmSigner(chain, wallet.privateKey), chain, ownerAddress as `0x${string}`);
}
