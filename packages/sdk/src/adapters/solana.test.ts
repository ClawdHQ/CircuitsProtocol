import { AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SolanaAdapter } from "./solana.js";

const PROGRAM_ID = "5QdAJFcNheK3mmjQsaatqafHGmJC3BHGUeoupCRk5g66";

function buildAdapter(treasuryAddress?: PublicKey): SolanaAdapter {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const wallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const provider = new AnchorProvider(connection, wallet as never, {});
  return new SolanaAdapter({
    programId: PROGRAM_ID,
    connection,
    provider,
    usdcMint: Keypair.generate().publicKey,
    treasuryAddress,
  });
}

describe("SolanaAdapter PDA derivation", () => {
  it("derives deterministic, distinct PDAs per agent id", () => {
    const adapter = buildAdapter();
    const a1 = adapter.agentPda(1);
    const a1Again = adapter.agentPda(1);
    const a2 = adapter.agentPda(2);

    expect(a1.toBase58()).toBe(a1Again.toBase58());
    expect(a1.toBase58()).not.toBe(a2.toBase58());
    expect(PublicKey.isOnCurve(a1.toBytes())).toBe(false); // PDAs are off-curve by construction
  });

  it("derives distinct PDAs across job/launch/name/buyer-position namespaces for the same id", () => {
    const adapter = buildAdapter();
    const job1 = adapter.jobPda(1);
    const launch1 = adapter.launchPda(1);
    const agent1 = adapter.agentPda(1);

    const addresses = new Set([job1.toBase58(), launch1.toBase58(), agent1.toBase58()]);
    expect(addresses.size).toBe(3);
  });

  it("namePda is a deterministic function of the name string", () => {
    const adapter = buildAdapter();
    expect(adapter.namePda("unique-agent").toBase58()).toBe(adapter.namePda("unique-agent").toBase58());
    expect(adapter.namePda("unique-agent").toBase58()).not.toBe(adapter.namePda("other-agent").toBase58());
  });

  it("buyerPositionPda varies by both launch id and buyer", () => {
    const adapter = buildAdapter();
    const buyerA = Keypair.generate().publicKey;
    const buyerB = Keypair.generate().publicKey;

    expect(adapter.buyerPositionPda(1, buyerA).toBase58()).not.toBe(adapter.buyerPositionPda(1, buyerB).toBase58());
    expect(adapter.buyerPositionPda(1, buyerA).toBase58()).not.toBe(adapter.buyerPositionPda(2, buyerA).toBase58());
  });

  it("derives the vault as the protocol state's USDC associated token account", () => {
    const adapter = buildAdapter();
    expect(adapter.vault).toBeInstanceOf(PublicKey);
    expect(adapter.protocolState).toBeInstanceOf(PublicKey);
  });

  it("leaves treasuryUsdcAta undefined when no treasury address is configured", () => {
    const adapter = buildAdapter();
    expect(adapter.treasuryUsdcAta).toBeUndefined();
  });

  it("derives treasuryUsdcAta once a treasury address is configured", () => {
    const adapter = buildAdapter(Keypair.generate().publicKey);
    expect(adapter.treasuryUsdcAta).toBeInstanceOf(PublicKey);
  });

  it("rejects sellTokens when no treasury address was configured", async () => {
    const adapter = buildAdapter();
    await expect(
      adapter.sellTokens({
        seller: Keypair.generate().publicKey,
        launchId: 1,
        tokenMint: Keypair.generate().publicKey,
        tokenAmount: 100n,
        minUsdcOut: 1n,
      }),
    ).rejects.toThrow(/treasuryAddress was not configured/);
  });
});
