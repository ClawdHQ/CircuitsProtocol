import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { getDecryptedAgentWallet } from "./agentWalletCustody.js";
import { getDecryptedRegistrarWallet } from "./registrarCustody.js";
import { isEvmPrismaChain, viemChainFor, rpcUrlFor, usdcAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";
import { withdrawErc20Balance, readUsdcBalance, type Erc20WithdrawResult } from "./signingEvmAdapter.js";
import { isSolanaPrismaChain, solanaConnectionFor, type SolanaPrismaChain } from "./solanaChainConfig.js";
import { withdrawSolanaUsdcBalance, readSolanaUsdcBalance } from "./signingSolanaAdapter.js";
import { Transaction as SuiTransaction } from "@mysten/sui/transactions";
import { suiClientFor, type SuiPrismaChain } from "./suiChainConfig.js";
import { withdrawSuiUsdcBalance, readSuiUsdcBalance, keypairFromSuiSecret, signAndExecuteSui } from "./signingSuiAdapter.js";
import type { Chain } from "@clawdhq/custody-db";

type ClaimableChain = EvmPrismaChain | SolanaPrismaChain | SuiPrismaChain;

// An AgentWallet only ever receives USDC (job payouts, launchpad creator allocations) — never
// native gas token, since nothing ever deposits into it directly the way a Subscription/Degen
// wallet does (an owner explicitly funding those covers their own gas too). So on EVM chains
// specifically, the wallet can hold USDC yet have zero balance to pay for the very transaction
// that would move it. The registrar wallet (already gas-funded for its own setAgentWallet
// calls — see registrarCustody.ts) sponsors a small top-up immediately before the agent wallet
// signs its own sweep, exactly once per claim if needed — the agent's own key still signs the
// real USDC transfer; the registrar only ever sends native token, never touches USDC.
const MIN_NATIVE_GAS_WEI = 5_000_000_000_000_000n; // 0.005 native token
const GAS_TOPUP_WEI = 10_000_000_000_000_000n; // 0.01 native token — a handful of ERC20 transfers' worth on testnet gas prices

async function ensureEvmGasForClaim(chain: EvmPrismaChain, agentAddress: `0x${string}`): Promise<void> {
  const viemChain = viemChainFor(chain);
  const transport = http(rpcUrlFor(chain));
  const publicClient = createPublicClient({ chain: viemChain, transport });

  const balance = await publicClient.getBalance({ address: agentAddress });
  if (balance >= MIN_NATIVE_GAS_WEI) return;

  const registrar = await getDecryptedRegistrarWallet(chain);
  // Best-effort: if no registrar is configured for this chain, fall through and let the real
  // USDC transfer fail with viem's own clear "insufficient funds for gas" error rather than
  // masking it — there's nothing else to sponsor the top-up from.
  if (!registrar) return;

  const account = privateKeyToAccount(registrar.privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: viemChain, transport });
  const hash = await walletClient.sendTransaction({ account, chain: viemChain, to: agentAddress, value: GAS_TOPUP_WEI });
  await publicClient.waitForTransactionReceipt({ hash });
}

// Solana's equivalent of the same gap: `withdrawSolanaUsdcBalance` signs its sweep with the
// agent wallet's own Keypair, which (per web3.js's `Transaction.sign` — the first signer
// becomes `feePayer` when none is set explicitly) makes the agent wallet the fee payer too. A
// freshly-provisioned AgentWallet only ever receives USDC via program transfers, never SOL, so
// it has nothing to pay that fee (or, on a first claim, the destination owner ATA's rent) with.
// Same fix shape as `ensureEvmGasForClaim`: the already-funded registrar wallet (see
// registrarCustody.ts) sponsors a small SOL top-up immediately before the agent wallet signs
// its own transfer — the agent's key still signs the real USDC transfer; the registrar only
// ever sends native SOL, never touches USDC.
const MIN_NATIVE_LAMPORTS = LAMPORTS_PER_SOL / 100; // 0.01 SOL
const LAMPORTS_TOPUP = LAMPORTS_PER_SOL / 50; // 0.02 SOL — covers the sweep's fee plus a destination ATA's rent if needed

async function ensureSolanaFeesForClaim(chain: SolanaPrismaChain, agentAddress: string): Promise<void> {
  const connection = solanaConnectionFor(chain);
  const agentPubkey = new PublicKey(agentAddress);

  const balance = await connection.getBalance(agentPubkey);
  if (balance >= MIN_NATIVE_LAMPORTS) return;

  const registrar = await getDecryptedRegistrarWallet(chain);
  // Best-effort: if no registrar is configured for this chain, fall through and let the real
  // USDC transfer fail with web3.js's own clear error rather than masking it — there's nothing
  // else to sponsor the top-up from.
  if (!registrar) return;

  const registrarKeypair = Keypair.fromSecretKey(bs58.decode(registrar.privateKey));
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: registrarKeypair.publicKey, toPubkey: agentPubkey, lamports: LAMPORTS_TOPUP }),
  );
  await sendAndConfirmTransaction(connection, tx, [registrarKeypair]);
}

// Sui's equivalent of the same gap: `withdrawSuiUsdcBalance` signs its sweep with the agent
// wallet's own Ed25519Keypair and (via `signAndExecuteSui`'s `tx.setSender`) that same address
// is the transaction's gas payer by default. A freshly-provisioned AgentWallet only ever
// receives USDC (a `Coin<USDC>` object transferred to it), never native SUI, so it has nothing
// to pay gas with. Same fix shape as the EVM/Solana claim paths: the already-funded registrar
// wallet sponsors a small SUI top-up immediately before the agent wallet signs its own sweep —
// the agent's key still signs the real USDC transfer; the registrar only ever sends native SUI,
// never touches USDC.
const MIST_PER_SUI = 1_000_000_000n;
const MIN_NATIVE_MIST = MIST_PER_SUI / 100n; // 0.01 SUI
const MIST_TOPUP = MIST_PER_SUI / 50n; // 0.02 SUI — comfortably covers a merge-and-transfer sweep's gas on testnet

async function ensureSuiGasForClaim(chain: SuiPrismaChain, agentAddress: string): Promise<void> {
  const client = suiClientFor(chain);

  const { totalBalance } = await client.getBalance({ owner: agentAddress });
  if (BigInt(totalBalance) >= MIN_NATIVE_MIST) return;

  const registrar = await getDecryptedRegistrarWallet(chain);
  // Best-effort: if no registrar is configured for this chain, fall through and let the real
  // USDC transfer fail with Sui's own clear "insufficient gas" error rather than masking it —
  // there's nothing else to sponsor the top-up from.
  if (!registrar) return;

  const registrarKeypair = keypairFromSuiSecret(registrar.privateKey);
  const tx = new SuiTransaction();
  const [topup] = tx.splitCoins(tx.gas, [MIST_TOPUP]);
  tx.transferObjects([topup], agentAddress);
  await signAndExecuteSui(chain, registrarKeypair, tx);

  // signAndExecuteSui already waits for this top-up transaction's own on-chain finality, but
  // the *read* path withdrawSuiUsdcBalance's gas-coin selection uses next (a separate
  // getOwnedObjects-backed query, effectively) can lag slightly behind that — confirmed
  // empirically against a live local network: the direct `sui client balance` CLI read showed
  // the new coin immediately while this SDK path still momentarily reported "No valid gas
  // coins found." Poll until the topped-up balance is actually visible rather than handing
  // back control the instant the transaction itself confirms.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { totalBalance: current } = await client.getBalance({ owner: agentAddress });
    if (BigInt(current) >= MIST_TOPUP) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Sweeps an agent's custodied wallet back to its verified current owner — never a
 * caller-supplied address. Callers (the claim API route) must resolve `ownerAddress` via a
 * *live* on-chain read of `agents[agentId].owner` immediately before calling this, never a
 * cached/stored value, so a just-completed Agent Exchange sale immediately revokes the old
 * owner's claim rights and grants them to the new owner — same "destination comes from a
 * verified source, never request input" shape Degen's withdrawal path (degenWithdraw.ts)
 * already uses. */
export async function claimAgentWallet(chain: ClaimableChain, agentChainId: string, ownerAddress: string): Promise<Erc20WithdrawResult> {
  const wallet = await getDecryptedAgentWallet(chain as Chain, agentChainId);
  if (!wallet) throw new Error("No wallet has been provisioned for this agent");

  if (isEvmPrismaChain(chain)) {
    await ensureEvmGasForClaim(chain, wallet.address as `0x${string}`);
    return withdrawErc20Balance(wallet.privateKey, viemChainFor(chain), rpcUrlFor(chain), usdcAddressFor(chain), ownerAddress as `0x${string}`);
  }
  if (isSolanaPrismaChain(chain)) {
    await ensureSolanaFeesForClaim(chain, wallet.address);
    return withdrawSolanaUsdcBalance(chain, wallet.privateKey, ownerAddress);
  }
  await ensureSuiGasForClaim(chain, wallet.address);
  return withdrawSuiUsdcBalance(chain, wallet.privateKey, ownerAddress);
}

/** Live USDC balance for an agent's custodied wallet, for display (Wallet tab) — not cached,
 * always a fresh chain read. Returns null if no wallet has been provisioned yet. */
export async function readAgentWalletBalance(chain: ClaimableChain, address: string): Promise<bigint | null> {
  if (isEvmPrismaChain(chain)) return readUsdcBalance(address as `0x${string}`, viemChainFor(chain), rpcUrlFor(chain), usdcAddressFor(chain));
  if (isSolanaPrismaChain(chain)) return readSolanaUsdcBalance(chain, address);
  return readSuiUsdcBalance(chain, address);
}
