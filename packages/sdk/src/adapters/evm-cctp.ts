import { getContract, pad, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { ensureErc20Allowance } from "./erc20.js";

export interface EvmCctpAdapterConfig {
  /** Circle's TokenMessengerV2 — same canonical address on every CCTP v2 testnet chain (see
   * .env.example's `*_CCTP_TOKEN_MESSENGER_ADDRESS`), not a ClawdHQ contract. */
  tokenMessengerAddress: Address;
  usdcAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

const tokenMessengerV2Abi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

interface TokenMessengerContract {
  write: {
    depositForBurn: (args: readonly [bigint, number, Hex, Address, Hex, bigint, number]) => Promise<Hex>;
  };
}

/** Any address may submit the resulting attestation via `receiveMessage` on the destination
 * chain — this app's own indexer relayer does so automatically (see
 * apps/indexer/src/relayers/crossChainIdentity.ts), the same as it already does for
 * ClawdHQCrossChainIdentity's messages. Matches that contract's own choice of an unrestricted
 * `destinationCaller`. */
const UNRESTRICTED_DESTINATION_CALLER: Hex = pad("0x00", { size: 32 });

/** Talks to Circle's TokenMessengerV2 — burns USDC on this chain for CCTP v2 to mint natively on
 * another chain. Unlike every ClawdHQ-contract adapter in this SDK, this one wraps a third-party
 * Circle contract, not one of this project's own deployments (see
 * `packages/circle/src/cctpBridge.ts` for the equivalent server-side, private-key-based flow this
 * mirrors for a Circle Social wallet, which never exposes a private key). Always burns at
 * *standard* finality (`maxFee: 0n`, `minFinalityThreshold: 2000`) rather than Circle's paid
 * "fast" tier — free, at the cost of waiting for hard finality on the source chain before the
 * relayer can complete the mint. */
export class EvmCctpAdapter {
  private readonly contract: TokenMessengerContract;
  private readonly tokenMessengerAddress: Address;
  private readonly usdcAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;

  constructor(config: EvmCctpAdapterConfig) {
    this.tokenMessengerAddress = config.tokenMessengerAddress;
    this.usdcAddress = config.usdcAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contract = getContract({
      address: config.tokenMessengerAddress,
      abi: tokenMessengerV2Abi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as TokenMessengerContract;
  }

  private getSenderAddress(): Address {
    const address = this.walletClient?.account?.address;
    if (!address) throw new Error("EvmCctpAdapter: no connected wallet account to send this transaction from.");
    return address;
  }

  /** Burns `amount` (6dp USDC) on this chain, minting the same amount to `mintRecipient` on
   * `destinationDomain` once the indexer's relayer submits Circle's attestation there — see this
   * class's own doc comment. Approves the TokenMessenger for `amount` first if needed. Returns
   * the burn transaction hash; the caller (see `useCctpSelfBridge`) is responsible for handing
   * that off to `/api/circle/wallet/self-bridge` so the relayer picks it up. */
  async depositForBurn(amount: bigint, destinationDomain: number, mintRecipient: Address): Promise<Hex> {
    const owner = this.getSenderAddress();
    await ensureErc20Allowance({ public: this.publicClient, wallet: this.walletClient }, this.usdcAddress, owner, this.tokenMessengerAddress, amount);

    const mintRecipientBytes32 = pad(mintRecipient, { size: 32 });
    return this.contract.write.depositForBurn([amount, destinationDomain, mintRecipientBytes32, this.usdcAddress, UNRESTRICTED_DESTINATION_CALLER, 0n, 2000]);
  }
}
