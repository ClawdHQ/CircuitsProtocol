import "../src/loadEnv.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
// Same CJS/ESM interop workaround as packages/custody-core/src/signingSolanaAdapter.ts's top
// comment and packages/sdk/src/adapters/solana.ts's — see either for the full explanation.
import * as anchorNamespace from "@coral-xyz/anchor";
import type { AnchorProvider as AnchorProviderType, Wallet as WalletType, Program as ProgramType, Idl } from "@coral-xyz/anchor";
import { getOrCreateRegistrarWallet } from "@clawdhq/custody-core";
import clawdhqAgentIdl from "../../../packages/contracts-solana/target/idl/clawdhq_agent.json" with { type: "json" };

const anchorPkg = "default" in anchorNamespace ? (anchorNamespace as unknown as { default: typeof anchorNamespace }).default : anchorNamespace;
const { AnchorProvider, Wallet, Program } = anchorPkg as unknown as {
  AnchorProvider: typeof AnchorProviderType;
  Wallet: typeof WalletType;
  Program: typeof ProgramType;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local-devnet-only bootstrap: clawdhq_agent's ProtocolState.registrar is initialized to
// `authority` as a placeholder (see clawdhq_agent's lib.rs `initialize` doc comment) — the
// indexer's actual privileged signer doesn't exist until custody-core provisions it at
// runtime. This script provisions that real wallet (idempotent — safe to re-run), rotates it
// in via the program's `set_registrar` instruction, and funds it with local SOL for
// transaction fees + ATA-rent sponsorship (see custody-core's ensureUsdcAtaFor), so the
// indexer's provisionAgentWalletOnChain can actually submit set_agent_wallet transactions.
// Mirrors packages/contracts-evm's local-dev deploy-and-seed.ts + this same script's EVM
// sibling (rotate-local-registrar.ts).

const CHAIN = "SOLANA_DEVNET" as const;
const PROTOCOL_SEED = Buffer.from("protocol");

async function main() {
  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL || "http://127.0.0.1:8899";
  const connection = new Connection(rpcUrl, "confirmed");

  const recordPath = path.resolve(__dirname, "../../../packages/contracts-solana/scripts/local-dev/local-devnet.json");
  if (!fs.existsSync(recordPath)) {
    throw new Error(`${recordPath} not found — run contracts-solana's deploy-and-seed.ts first.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { programId: string };

  // Same local keypair deploy-and-seed.ts used as `authority` when it called `initialize`.
  const authority = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME || "", ".config/solana/id.json"), "utf8"))),
  );

  console.log(`Provisioning the real registrar wallet for ${CHAIN}...`);
  const registrarWallet = await getOrCreateRegistrarWallet(CHAIN);
  const registrarPubkey = new PublicKey(registrarWallet.address);
  console.log(`Registrar wallet: ${registrarWallet.address}`);

  const programId = new PublicKey(record.programId);
  const [protocolState] = PublicKey.findProgramAddressSync([PROTOCOL_SEED], programId);

  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(clawdhqAgentIdl as Idl, provider);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protocolAccount = (await (program.account as any).protocolState.fetch(protocolState)) as { registrar: PublicKey };
  if (!protocolAccount.registrar.equals(registrarPubkey)) {
    console.log(`Rotating registrar: ${protocolAccount.registrar.toBase58()} -> ${registrarPubkey.toBase58()}...`);
    await program.methods
      .setRegistrar(registrarPubkey)
      .accountsPartial({ authority: authority.publicKey, protocolState })
      .rpc();
  } else {
    console.log("Registrar already rotated in — skipping.");
  }

  const balance = await connection.getBalance(registrarPubkey);
  const minBalance = 1 * LAMPORTS_PER_SOL;
  if (balance < minBalance) {
    console.log("Funding registrar wallet with local SOL for fees + ATA rent...");
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: registrarPubkey, lamports: 2 * LAMPORTS_PER_SOL }),
    );
    await sendAndConfirmTransaction(connection, tx, [authority]);
  }

  console.log("Registrar wallet ready:", registrarWallet.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
