import {
  initiateDeveloperControlledWalletsClient,
  Blockchain,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";

// Circle Wallets (developer-controlled) — the owner-facing counterpart to this app's existing
// custodied wallets (packages/custody-core), which are built for *agents* to sign and transact
// autonomously. This module is for the human owner side instead: giving a non-crypto-native
// owner a real Arc Testnet address (to fund a subscription, claim an agent wallet's balance
// into, etc.) without requiring them to install MetaMask or manage a seed phrase themselves.
// Circle custodies the actual key material; this app only ever holds a wallet *id* plus the
// API key/entity secret needed to direct it.
//
// Every method/field name below (client shape, ClientParams, CreateWalletsInput,
// GetWalletTokenBalanceInput, CreateTransferTransactionInput, the "ARC-TESTNET" blockchain
// literal, RequestTestnetTokensInput) was read directly from the installed SDK's own shipped
// .d.ts, not guessed from documentation prose.

export interface CircleWalletsConfig {
  apiKey: string;
  entitySecret: string;
}

export function createCircleClient(config: CircleWalletsConfig): CircleDeveloperControlledWalletsClient {
  return initiateDeveloperControlledWalletsClient({ apiKey: config.apiKey, entitySecret: config.entitySecret });
}

export interface OwnerWallet {
  walletSetId: string;
  walletId: string;
  address: string;
}

/** Creates a fresh wallet set + a single EOA wallet on Arc Testnet for one owner. A wallet set
 * is required by the API even for a single wallet — callers that create many owner wallets
 * over time should keep re-using one wallet set (pass `existingWalletSetId`) rather than
 * minting a new one per owner, since a wallet set has no per-owner meaning of its own. */
export async function createOwnerWallet(
  client: CircleDeveloperControlledWalletsClient,
  ownerRefId: string,
  existingWalletSetId?: string,
): Promise<OwnerWallet> {
  const walletSetId =
    existingWalletSetId ?? (await client.createWalletSet({ name: `ClawdHQ owner wallets` })).data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle Wallets: failed to resolve a wallet set id");

  const response = await client.createWallets({
    blockchains: [Blockchain.ArcTestnet],
    count: 1,
    walletSetId,
    // `name` has an undocumented length limit shorter than "ClawdHQ owner " + a 42-char address
    // (confirmed empirically: that combined string 400s with "API parameter invalid" while the
    // same address alone in `refId` succeeds) — keep name short and put the actual owner
    // reference in `refId`, which has no such issue.
    metadata: [{ refId: ownerRefId, name: "ClawdHQ" }],
  });
  const wallet = response.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) throw new Error("Circle Wallets: wallet creation returned no wallet");

  return { walletSetId, walletId: wallet.id, address: wallet.address };
}

/** Requests free testnet USDC from Circle's own faucet directly into an owner wallet — lets an
 * owner skip the manual faucet.circle.com flow entirely for a demo/dev flow.
 *
 * Uses `Blockchain.ArcTestnet` here, not the seemingly-more-correct `TestnetBlockchain.ArcTestnet`
 * the SDK's own .d.ts declares for this parameter: `TestnetBlockchain` is typed as a real
 * exported const, but the installed SDK build (10.8.0) doesn't actually export it at runtime —
 * confirmed by a real `ReferenceError` importing it, not assumed. Same string value
 * ("ARC-TESTNET") either way, so this is a straight substitute, not a behavior change. */
export async function fundOwnerWalletFromFaucet(client: CircleDeveloperControlledWalletsClient, address: string): Promise<void> {
  await client.requestTestnetTokens({ address, blockchain: Blockchain.ArcTestnet, usdc: true });
}

export interface OwnerWalletBalance {
  amountUsdc: string;
  tokenId: string;
}

/** Arc's native gas token *is* USDC (see packages/circle's package-level doc comment and
 * chains.ts's ARC_TESTNET entry), so the native-balance entry in `tokenBalances` (`isNative:
 * true`) is USDC itself — not a separate ERC-20 line item the way it would be on every other
 * EVM chain this app supports. Falls back to a symbol match for robustness if that ever
 * changes. Returns undefined if the wallet has never received any Arc-USDC (the native entry
 * may not appear until an initial deposit is observed on some accounts). */
export async function getOwnerWalletUsdcBalance(client: CircleDeveloperControlledWalletsClient, walletId: string): Promise<OwnerWalletBalance | undefined> {
  const response = await client.getWalletTokenBalance({ id: walletId });
  const balances = response.data?.tokenBalances ?? [];
  const usdc = balances.find((b) => b.token.isNative || b.token.symbol === "USDC");
  if (!usdc) return undefined;
  return { amountUsdc: usdc.amount, tokenId: usdc.token.id };
}

/** Sends USDC out of an owner's Circle-custodied Arc wallet — e.g. to fund a subscription
 * wallet or an agent wallet's deposit address. Circle handles signing entirely server-side;
 * this app never sees a private key for these wallets, unlike the custodied wallets in
 * packages/custody-core. */
export async function sendFromOwnerWallet(
  client: CircleDeveloperControlledWalletsClient,
  walletId: string,
  destinationAddress: string,
  amountUsdc: string,
): Promise<{ transactionId: string }> {
  const balance = await getOwnerWalletUsdcBalance(client, walletId);
  if (!balance) throw new Error(`Circle Wallets: wallet ${walletId} has no USDC token balance to resolve a tokenId from`);

  const response = await client.createTransaction({
    walletId,
    tokenId: balance.tokenId,
    destinationAddress,
    amount: [amountUsdc],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const transactionId = response.data?.id;
  if (!transactionId) throw new Error("Circle Wallets: transfer returned no transaction id");
  return { transactionId };
}
