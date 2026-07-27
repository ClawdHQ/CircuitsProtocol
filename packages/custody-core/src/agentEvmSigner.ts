import { custom, numberToHex } from "viem";
import { createCircleClient } from "@clawdhq/circle";
import { prisma, WalletStatus, AgentWalletCustodyType } from "@clawdhq/custody-db";
import { getDecryptedAgentWallet } from "./agentWalletCustody.js";
import { getDecryptedCircleAgentWalletCredential } from "./circleAgentCredentialCustody.js";
import { createCircleAgentSignerProvider } from "./circleAgentSignerProvider.js";
import { localEvmSigner, type EvmSigner } from "./signingEvmAdapter.js";
import { viemChainFor, type EvmPrismaChain } from "./evmChainConfig.js";

export interface AgentEvmSigner extends EvmSigner {
  /** Which custody domain this signer came from — claimAgentWallet uses this to skip the
   * registrar's native-gas top-up step for CIRCLE wallets (Circle's own infrastructure covers
   * gas for its wallets; sending this app's registrar funds to a wallet it doesn't fully custody
   * would be an unrelated funding decision, not this app's to make). */
  custodyType: "LOCAL" | "CIRCLE";
}

/** The one branch point every EVM write against an agent's AgentWallet goes through instead of
 * independently deriving a signer from a raw decrypted key — see signingEvmAdapter.ts and
 * uniswapSwap.ts, whose functions all take an EvmSigner now instead of a `privateKey: string`.
 * Returns null if no wallet has been provisioned for this agent yet, same contract
 * getDecryptedAgentWallet already has. */
export async function getAgentEvmSigner(chain: EvmPrismaChain, agentChainId: string): Promise<AgentEvmSigner | null> {
  const wallet = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!wallet || wallet.status !== WalletStatus.ACTIVE) return null;

  if (wallet.custodyType === AgentWalletCustodyType.CIRCLE) {
    if (!wallet.circleWalletId || !wallet.circleCredentialId) {
      throw new Error(`AgentWallet ${chain}:${agentChainId} is Circle-custodied but missing circleWalletId/circleCredentialId — this row was written incorrectly.`);
    }
    const credential = await getDecryptedCircleAgentWalletCredential(wallet.circleCredentialId);
    const client = createCircleClient({ apiKey: credential.apiKey, entitySecret: credential.entitySecret });
    const provider = createCircleAgentSignerProvider({
      client,
      walletId: wallet.circleWalletId,
      address: wallet.address as `0x${string}`,
      chainIdHex: numberToHex(viemChainFor(chain).id),
    });
    return { address: wallet.address as `0x${string}`, custodyType: "CIRCLE", account: wallet.address as `0x${string}`, transport: custom(provider) };
  }

  const decrypted = await getDecryptedAgentWallet(chain, agentChainId);
  if (!decrypted) return null;
  return { ...localEvmSigner(chain, decrypted.privateKey), custodyType: "LOCAL" };
}
