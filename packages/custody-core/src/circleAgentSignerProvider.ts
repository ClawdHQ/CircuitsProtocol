import { formatEther, type Hex } from "viem";
import { createCircleClient, executeAgentContractCall } from "@clawdhq/circle";

// Typed off createCircleClient's own return type rather than importing
// CircleDeveloperControlledWalletsClient from @circle-fin/developer-controlled-wallets directly
// — that package isn't a direct dependency of custody-core (only @clawdhq/circle's is), same
// reasoning apps/web/src/lib/server/circle/ownerWallet.ts's own doc comment gives.
interface Deps {
  client: ReturnType<typeof createCircleClient>;
  walletId: string;
  address: Hex;
  chainIdHex: Hex;
}

/** Server-side sibling of apps/web/src/lib/circle/circleContractExecutionProvider.ts — same
 * minimal EIP-1193-shaped provider intercepting `eth_sendTransaction`, same reasoning for why
 * only eth_chainId/eth_accounts/eth_sendTransaction need handling (see that file's doc comment:
 * a JSON-RPC-style account defers all gas/nonce/fee filling to the provider). The browser
 * version routes through a PIN-approval challenge because a *human* has to authorize each write;
 * this one calls Circle's Developer-Controlled Wallets API directly because nobody needs to
 * approve anything at request time — the owner already handed over standing sign authority when
 * they onboarded this wallet (see circleAgentCredentialCustody.ts's own doc comment on what that
 * implies). Reads still go through a real PublicClient untouched; only writes flow through
 * this. */
export function createCircleAgentSignerProvider(deps: Deps): { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } {
  const { client, walletId, address, chainIdHex } = deps;

  return {
    async request({ method, params }) {
      switch (method) {
        case "eth_chainId":
          return chainIdHex;
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_sendTransaction": {
          const tx = (params as [{ to?: Hex; data?: Hex; value?: Hex }] | undefined)?.[0];
          if (!tx?.to) throw new Error("Circle contract execution requires a `to` address — contract deploys aren't supported through this path.");

          const amount = tx.value && BigInt(tx.value) > 0n ? formatEther(BigInt(tx.value)) : undefined;
          const { txHash } = await executeAgentContractCall(client, { walletId, contractAddress: tx.to, callData: tx.data ?? "0x", amount });
          return txHash;
        }
        default:
          throw new Error(`Circle agent-wallet signer: unsupported method "${method}"`);
      }
    },
  };
}
