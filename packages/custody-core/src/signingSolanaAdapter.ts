// Same CJS/ESM interop problem as adapters/solana.ts in @clawdhq/sdk — see that file's top
// comment. Wallet/AnchorProvider are needed here as values (to construct a provider from a raw
// Keypair), so they need the same namespace-import workaround; Idl/other types don't.
import * as anchorNamespace from "@coral-xyz/anchor";
import type { AnchorProvider as AnchorProviderType, Wallet as WalletType } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import bs58 from "bs58";
import { SolanaAdapter } from "@clawdhq/sdk";
import { solanaConnectionFor, solanaProgramIdFor, solanaUsdcMintFor, solanaTreasuryFor, type SolanaPrismaChain } from "./solanaChainConfig.js";

const anchorPkg = "default" in anchorNamespace ? (anchorNamespace as unknown as { default: typeof anchorNamespace }).default : anchorNamespace;
const { AnchorProvider, Wallet } = anchorPkg as unknown as { AnchorProvider: typeof AnchorProviderType; Wallet: typeof WalletType };

export function keypairFromSecret(secretKeyBase58: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}

/** Builds a SolanaAdapter that signs with a server-held Keypair instead of a browser wallet —
 * the write-capable counterpart to signingEvmAdapter.ts's getSigningEvmAdapter, for the same
 * "one place allowed to hold key material" reason. anchor.Wallet's job is exactly this: wrap a
 * raw Keypair so AnchorProvider can drive it like any other wallet adapter. */
export function getSigningSolanaAdapter(chain: SolanaPrismaChain, secretKeyBase58: string): SolanaAdapter {
  const keypair = keypairFromSecret(secretKeyBase58);
  const connection = solanaConnectionFor(chain);
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const treasury = solanaTreasuryFor(chain);
  return new SolanaAdapter({
    programId: solanaProgramIdFor(chain),
    connection,
    provider,
    usdcMint: new PublicKey(solanaUsdcMintFor(chain)),
    treasuryAddress: treasury ? new PublicKey(treasury) : undefined,
  });
}

/** postJob's `employerUsdcAta` account has no `init` constraint (see SolanaAdapter.postJob in
 * packages/sdk) — a freshly generated custodied wallet with zero prior on-chain history needs
 * its USDC associated token account created before its first job post. Idempotent and
 * self-funded (the wallet pays its own rent from whatever SOL it's been deposited), so this is
 * safe to call unconditionally before every run rather than tracked as a one-time setup step. */
export async function ensureOwnUsdcAta(chain: SolanaPrismaChain, secretKeyBase58: string): Promise<PublicKey> {
  const keypair = keypairFromSecret(secretKeyBase58);
  const connection = solanaConnectionFor(chain);
  const usdcMint = new PublicKey(solanaUsdcMintFor(chain));
  const ata = await getOrCreateAssociatedTokenAccount(connection, keypair, usdcMint, keypair.publicKey);
  return ata.address;
}

/** Same idea as `ensureOwnUsdcAta`, but for a *different* owner than the paying signer — used
 * to create an AgentWallet's USDC ATA right after provisioning, paid for by the registrar
 * (Solana's equivalent of the EVM port's `ensureEvmGasForClaim` gas top-up: a freshly generated
 * AgentWallet only ever receives USDC via program transfers, never SOL, so it has nothing to
 * pay its own ATA rent with — `payer_secretKeyBase58` sponsors that cost instead). Idempotent —
 * `getOrCreateAssociatedTokenAccount` no-ops if the ATA already exists. */
export async function ensureUsdcAtaFor(chain: SolanaPrismaChain, payerSecretKeyBase58: string, owner: PublicKey): Promise<PublicKey> {
  const payer = keypairFromSecret(payerSecretKeyBase58);
  const connection = solanaConnectionFor(chain);
  const usdcMint = new PublicKey(solanaUsdcMintFor(chain));
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, owner);
  return ata.address;
}

/** Live USDC balance for a custodied Solana address — 0 if its associated token account hasn't
 * been created yet (a freshly-generated, never-funded wallet), matching degenWithdraw.ts's
 * existing TokenAccountNotFoundError-as-zero convention rather than treating it as an error. */
export async function readSolanaUsdcBalance(chain: SolanaPrismaChain, address: string): Promise<bigint> {
  const connection = solanaConnectionFor(chain);
  const usdcMint = new PublicKey(solanaUsdcMintFor(chain));
  const ata = getAssociatedTokenAddressSync(usdcMint, new PublicKey(address));
  try {
    return (await getAccount(connection, ata)).amount;
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError) return 0n;
    throw error;
  }
}

export interface SolanaWithdrawResult {
  txHashOrRef: string;
  amount: string;
  asset: string;
}

/** Sweeps a custodied Solana wallet's entire USDC balance to `to` — same fire-and-confirm
 * shape as degenWithdraw.ts's withdrawSolanaUsdc (this package's one other Solana withdraw
 * precedent), confirmed rather than fire-and-forget so a withdrawal response only reports
 * success once it's actually landed. Callers are responsible for resolving `to` themselves from
 * a verified session/on-chain source, never unchecked request input. */
export async function withdrawSolanaUsdcBalance(chain: SolanaPrismaChain, secretKeyBase58: string, to: string): Promise<SolanaWithdrawResult> {
  const keypair = keypairFromSecret(secretKeyBase58);
  const connection = solanaConnectionFor(chain);
  const usdcMint = new PublicKey(solanaUsdcMintFor(chain));
  const fromAta = getAssociatedTokenAddressSync(usdcMint, keypair.publicKey);

  let balance: bigint;
  try {
    balance = (await getAccount(connection, fromAta)).amount;
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError) return { txHashOrRef: "", amount: "0", asset: "USDC" };
    throw error;
  }
  if (balance === 0n) return { txHashOrRef: "", amount: "0", asset: "USDC" };

  const toAta = await getOrCreateAssociatedTokenAccount(connection, keypair, usdcMint, new PublicKey(to));
  const tx = new Transaction().add(createTransferInstruction(fromAta, toAta.address, keypair.publicKey, balance));
  const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);
  return { txHashOrRef: signature, amount: balance.toString(), asset: "USDC" };
}
