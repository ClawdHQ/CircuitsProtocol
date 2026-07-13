import { createPublicClient, createWalletClient, http, pad, parseUnits, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Circle Gateway — a unified USDC balance across chains, with sub-500ms attestation-based
// minting. This is the same primitive Circle now markets as "Nanopayments" for agentic/
// high-frequency payment flows (see the hackathon's own "Nanopayments" tool listing) — the
// x402 facilitator (packages/custody-core/src/facilitatorPullPayment.ts) and Subscriptions'
// execution engine are the natural callers of `mintOnArc`/`bridgeViaGateway` below for
// instant, cross-chain-funded settlement, though wiring either of those in is a follow-up, not
// done by this module itself.
//
// Every field name/type below (TransferSpec, BurnIntent, the EIP-712 domain, the /v1/balances
// and /v1/transfer request+response shapes, and the deposit/gatewayMint ABIs) was confirmed
// against Circle's own circlefin/skills reference docs, not guessed from prose — see this
// package's git history for the exact sources. The one genuinely unconfirmed detail is whether
// TransferSpec.value/BurnIntent.maxFee are raw USDC base units (6 decimals) or some other
// scale; this module assumes 6 decimals (matching every other USDC amount in this codebase and
// the /v1/balances response's own "decimal string ... with 6 decimals" documentation) — verify
// against a real signed burn before relying on this for anything beyond a demo.

const GATEWAY_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

const TRANSFER_SPEC_TYPE = [
  { name: "version", type: "uint32" },
  { name: "sourceDomain", type: "uint32" },
  { name: "destinationDomain", type: "uint32" },
  { name: "sourceContract", type: "bytes32" },
  { name: "destinationContract", type: "bytes32" },
  { name: "sourceToken", type: "bytes32" },
  { name: "destinationToken", type: "bytes32" },
  { name: "sourceDepositor", type: "bytes32" },
  { name: "destinationRecipient", type: "bytes32" },
  { name: "sourceSigner", type: "bytes32" },
  { name: "destinationCaller", type: "bytes32" },
  { name: "value", type: "uint256" },
  { name: "salt", type: "bytes32" },
  { name: "hookData", type: "bytes" },
] as const;

const BURN_INTENT_TYPE = [
  { name: "maxBlockHeight", type: "uint256" },
  { name: "maxFee", type: "uint256" },
  { name: "spec", type: "TransferSpec" },
] as const;

const GATEWAY_MINT_ABI = [
  {
    type: "function",
    name: "gatewayMint",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const GATEWAY_WALLET_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

function addressToBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

export interface GatewayEvmChainConfig {
  domain: number;
  chain: Chain;
  rpcUrl: string;
  gatewayWalletAddress: Address;
  gatewayMinterAddress: Address;
  usdcAddress: Address;
}

export interface GatewayBalanceSource {
  domain: number;
  /** Hex address for EVM, base58 for Solana. */
  depositor: string;
}

export interface GatewayBalance extends GatewayBalanceSource {
  /** Decimal string in human-readable USDC units (6 decimals), per Circle's own docs. */
  balance: string;
  /** Deposited but not yet finalized into `balance` — confirmed present on the real API
   * response (not in Circle's own reference docs at the time this was written). */
  pendingBatch: string;
}

/** POST /v1/balances — the "unified balance" read: how much USDC this depositor has available
 * to move instantly out of Gateway, summed across whichever chains they've deposited into. */
export async function getUnifiedBalance(apiUrl: string, sources: GatewayBalanceSource[]): Promise<GatewayBalance[]> {
  const response = await fetch(`${apiUrl}/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources }),
  });
  if (!response.ok) throw new Error(`Gateway /v1/balances failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { balances: GatewayBalance[] };
  return body.balances;
}

/** Deposits USDC into the GatewayWallet contract on an EVM chain, crediting the depositor's
 * unified balance. A plain ERC-20 transfer to the contract does *not* do this — `deposit()`
 * must be called explicitly (per Circle's own docs). */
export async function depositToGateway(config: GatewayEvmChainConfig, privateKey: Hex, amountUsdc: string): Promise<{ approveTx: Hex; depositTx: Hex }> {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl) });
  const value = parseUnits(amountUsdc, 6);

  const approveTx = await walletClient.writeContract({
    address: config.usdcAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [config.gatewayWalletAddress, value],
  });
  const depositTx = await walletClient.writeContract({
    address: config.gatewayWalletAddress,
    abi: GATEWAY_WALLET_DEPOSIT_ABI,
    functionName: "deposit",
    args: [config.usdcAddress, value],
  });
  return { approveTx, depositTx };
}

export interface RequestGatewayTransferInput {
  apiUrl: string;
  source: GatewayEvmChainConfig;
  destination: GatewayEvmChainConfig;
  /** The depositor's private key on the source chain — signs the EIP-712 burn intent. Never a
   * real broadcast itself; only Gateway's off-chain attestation service sees the signature
   * until `mintOnArc` submits it on-chain. */
  sourcePrivateKey: Hex;
  recipientAddress: Address;
  amountUsdc: string;
  /** Blocks of headroom on the source chain before the burn intent expires. Defaults to ~1000
   * blocks, generous for a testnet demo; tune down for a tighter-lived intent. */
  blockHeightBuffer?: bigint;
  /** Max fee the signer authorizes, in USDC base units (6 decimals). Defaults to $0.01 —
   * Gateway's actual fee is typically far smaller; this is a ceiling, not the real charge. */
  maxFeeUsdc?: bigint;
}

export interface GatewayAttestation {
  attestation: Hex;
  signature: Hex;
}

/** Builds and signs a Gateway burn intent (EIP-712, per Circle's published TransferSpec/
 * BurnIntent schema), submits it to POST /v1/transfer, and returns the attestation + signature
 * `mintOnArc` needs. This is the "instant settlement" leg — Gateway responds with a valid
 * attestation before the underlying burn is even finalized on the source chain. */
export async function requestGatewayTransfer(input: RequestGatewayTransferInput): Promise<GatewayAttestation> {
  const { apiUrl, source, destination, sourcePrivateKey, recipientAddress, amountUsdc, blockHeightBuffer = 1000n, maxFeeUsdc = 10_000n } = input;

  const account = privateKeyToAccount(sourcePrivateKey);
  const publicClient = createPublicClient({ chain: source.chain, transport: http(source.rpcUrl) });
  const currentBlock = await publicClient.getBlockNumber();

  const salt = crypto.getRandomValues(new Uint8Array(32));
  const saltHex = ("0x" + Buffer.from(salt).toString("hex")) as Hex;

  const spec = {
    version: 1,
    sourceDomain: source.domain,
    destinationDomain: destination.domain,
    sourceContract: addressToBytes32(source.gatewayWalletAddress),
    destinationContract: addressToBytes32(destination.gatewayMinterAddress),
    sourceToken: addressToBytes32(source.usdcAddress),
    destinationToken: addressToBytes32(destination.usdcAddress),
    sourceDepositor: addressToBytes32(account.address),
    destinationRecipient: addressToBytes32(recipientAddress),
    sourceSigner: addressToBytes32(account.address),
    destinationCaller: addressToBytes32("0x0000000000000000000000000000000000000000"),
    value: parseUnits(amountUsdc, 6),
    salt: saltHex,
    hookData: "0x" as Hex,
  };

  const burnIntent = {
    maxBlockHeight: currentBlock + blockHeightBuffer,
    maxFee: maxFeeUsdc,
    spec,
  };

  const signature = await account.signTypedData({
    domain: GATEWAY_DOMAIN,
    types: { TransferSpec: [...TRANSFER_SPEC_TYPE], BurnIntent: [...BURN_INTENT_TYPE] },
    primaryType: "BurnIntent",
    message: burnIntent,
  });

  const response = await fetch(`${apiUrl}/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // BigInt fields (maxBlockHeight, maxFee, spec.value) don't survive JSON.stringify by
    // default — the API expects decimal strings, so stringify every bigint explicitly.
    body: JSON.stringify([{ burnIntent, signature }], (_key, val) => (typeof val === "bigint" ? val.toString() : val)),
  });
  if (!response.ok) throw new Error(`Gateway /v1/transfer failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as GatewayAttestation;
}

/** Calls GatewayMinter.gatewayMint on the destination chain (Arc, in this app's case) with the
 * attestation Gateway's API returned — the final leg that actually credits the recipient. */
export async function mintOnArc(destination: GatewayEvmChainConfig, minterPrivateKey: Hex, attestation: GatewayAttestation): Promise<Hex> {
  const account = privateKeyToAccount(minterPrivateKey);
  const walletClient = createWalletClient({ account, chain: destination.chain, transport: http(destination.rpcUrl) });
  return walletClient.writeContract({
    address: destination.gatewayMinterAddress,
    abi: GATEWAY_MINT_ABI,
    functionName: "gatewayMint",
    args: [attestation.attestation, attestation.signature],
  });
}
