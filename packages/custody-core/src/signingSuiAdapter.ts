import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiAdapter } from "@clawdhq/sdk";
import { suiClientFor, suiPackageIdFor, suiProtocolStateIdFor, suiUsdcCoinTypeFor, type SuiPrismaChain } from "./suiChainConfig.js";

export function keypairFromSuiSecret(secretKey: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(secretKey);
}

/** Retries a "build a Transaction referencing an object this same process just created in a
 * prior transaction, then sign+execute" step a few times on the specific error this hits —
 * `tx.object(id)`'s automatic version resolution (used internally by every SuiAdapter method
 * that takes a plain object-id string, e.g. postJob's budgetCoin) reads through a path that can
 * briefly lag behind a just-finalized transaction's own effects, even though the object is
 * already independently readable via a plain getObject. `buildAndExecute` must construct a
 * fresh Transaction each attempt — a Transaction that failed to build/execute shouldn't be
 * reused. Not needed for objects created well before this process touches them (e.g. a job a
 * human reviews minutes later), only for a same-run create-then-immediately-reference handoff. */
export async function retryOnFreshObjectLag<T>(buildAndExecute: () => Promise<T>, attempts = 5, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await buildAndExecute();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("does not exist") || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Signs and executes an unsigned Transaction (PTB) built by SuiAdapter's methods, setting the
 * sender explicitly (rather than relying on signAndExecuteTransaction to infer it from the
 * signer) and throwing on an on-chain abort — unlike EVM's fire-and-forget writeContract or
 * Solana's throws-on-failure `.rpc()`, Sui's RPC call itself succeeds even when the Move
 * execution aborts, so effects.status has to be checked explicitly or a reverted transaction
 * would be recorded as SUCCEEDED. */
export async function signAndExecuteSui(chain: SuiPrismaChain, keypair: Ed25519Keypair, tx: Transaction) {
  const client = suiClientFor(chain);
  tx.setSender(keypair.toSuiAddress());
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(`Sui transaction failed: ${result.effects?.status.error ?? "unknown error"}`);
  }
  return result;
}

/** Read-only PTB-building adapter — signing/execution happens separately (see
 * signAndExecuteTransaction call sites in subscriptionRunJob.ts etc.), matching the SDK's own
 * "callers sign and execute" design (SuiAdapter never holds a signer, unlike
 * getSigningEvmAdapter/getSigningSolanaAdapter). */
export function getSigningSuiAdapter(chain: SuiPrismaChain): SuiAdapter {
  return new SuiAdapter({
    packageId: suiPackageIdFor(chain),
    client: suiClientFor(chain),
    protocolStateId: suiProtocolStateIdFor(chain),
    usdcCoinType: suiUsdcCoinTypeFor(chain),
  });
}

export async function readSuiUsdcBalance(chain: SuiPrismaChain, address: string): Promise<bigint> {
  const client = suiClientFor(chain);
  const { totalBalance } = await client.getBalance({ owner: address, coinType: suiUsdcCoinTypeFor(chain) });
  return BigInt(totalBalance);
}

/** Sui's post_job (and every other budget-consuming Move call in this package) takes a specific
 * Coin<USDC> object and escrows/spends its *entire* value — no separate amount argument, no
 * refund (see marketplace.move's post_job: `let budget_value = budget.value();`). A wallet's
 * USDC may be split across multiple coin objects from separate past deposits, so this merges as
 * many as needed to cover `budgetMist` into one, then splits off exactly that amount as its own
 * confirmed object — submitted as its own transaction (rather than inlined into postJob's PTB)
 * so this stays a plain "give me a coin id" helper without needing to fork SuiAdapter.postJob's
 * `budgetCoin: string` signature to also accept a same-PTB TransactionArgument. If a run fails
 * after this succeeds, the exact-value coin is simply left in the wallet as a separate object —
 * not lost, and the next run's coin selection handles it the same as any other coin. */
export async function resolveExactUsdcCoin(chain: SuiPrismaChain, secretKey: string, budgetMist: bigint): Promise<string> {
  const keypair = keypairFromSuiSecret(secretKey);
  const client = suiClientFor(chain);
  const coinType = suiUsdcCoinTypeFor(chain);
  const owner = keypair.toSuiAddress();

  const { data: coins } = await client.getCoins({ owner, coinType });
  if (coins.length === 0) throw new Error("No USDC coins found in this wallet.");

  const sorted = [...coins].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
  if (BigInt(sorted[0].balance) === budgetMist) return sorted[0].coinObjectId;

  let accumulated = BigInt(sorted[0].balance);
  const toMerge: string[] = [];
  for (let i = 1; i < sorted.length && accumulated < budgetMist; i++) {
    toMerge.push(sorted[i].coinObjectId);
    accumulated += BigInt(sorted[i].balance);
  }
  if (accumulated < budgetMist) throw new Error("Insufficient USDC across all coin objects to cover the budget.");

  const tx = new Transaction();
  const primary = tx.object(sorted[0].coinObjectId);
  if (toMerge.length > 0) tx.mergeCoins(primary, toMerge.map((id) => tx.object(id)));
  const [exact] = tx.splitCoins(primary, [budgetMist]);
  tx.transferObjects([exact], owner);

  let result;
  try {
    result = await signAndExecuteSui(chain, keypair, tx);
  } catch (error) {
    throw new Error(`Couldn't prepare an exact-budget USDC coin: ${error instanceof Error ? error.message : String(error)}`);
  }
  const created = result.objectChanges?.find((c) => c.type === "created" && "objectType" in c && c.objectType.includes(`Coin<${coinType}>`));
  if (!created || !("objectId" in created)) throw new Error("Couldn't resolve the split coin's object id from the transaction result.");
  return created.objectId;
}

export interface SuiWithdrawResult {
  txHashOrRef: string;
  amount: string;
  asset: string;
}

/** Sweeps a custodied Sui wallet's entire USDC balance to `to` — merges every USDC coin object
 * it holds into one and transfers that whole coin (no split needed, unlike resolveExactUsdcCoin,
 * since the intent here is "send everything," not "send exactly N"). */
export async function withdrawSuiUsdcBalance(chain: SuiPrismaChain, secretKey: string, to: string): Promise<SuiWithdrawResult> {
  const keypair = keypairFromSuiSecret(secretKey);
  const client = suiClientFor(chain);
  const coinType = suiUsdcCoinTypeFor(chain);
  const owner = keypair.toSuiAddress();

  const { data: coins } = await client.getCoins({ owner, coinType });
  if (coins.length === 0) return { txHashOrRef: "", amount: "0", asset: "USDC" };
  const balance = coins.reduce((sum, c) => sum + BigInt(c.balance), 0n);
  if (balance === 0n) return { txHashOrRef: "", amount: "0", asset: "USDC" };

  const tx = new Transaction();
  const primary = tx.object(coins[0].coinObjectId);
  if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1).map((c) => tx.object(c.coinObjectId)));
  tx.transferObjects([primary], to);

  const result = await signAndExecuteSui(chain, keypair, tx);
  return { txHashOrRef: result.digest, amount: balance.toString(), asset: "USDC" };
}
