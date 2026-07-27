import "../src/loadEnv.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
// Same CJS/ESM interop workaround as rotate-local-registrar-solana.ts — see that file's comment.
import * as anchorNamespace from "@coral-xyz/anchor";
import type { AnchorProvider as AnchorProviderType, Wallet as WalletType } from "@coral-xyz/anchor";
import { SolanaAdapter } from "@clawdhq/sdk";
import { claimAgentWallet, readAgentWalletBalance } from "@clawdhq/custody-core";

const anchorPkg = "default" in anchorNamespace ? (anchorNamespace as unknown as { default: typeof anchorNamespace }).default : anchorNamespace;
const { AnchorProvider, Wallet } = anchorPkg as unknown as { AnchorProvider: typeof AnchorProviderType; Wallet: typeof WalletType };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN = "SOLANA_DEVNET" as const;

// End-to-end proof (mirrors the EVM verification already done for Phase 2) that the universal
// agent wallet redirect actually works on Solana: register a fresh agent, confirm the indexer
// auto-provisions its wallet, complete a job and confirm the payout lands in the agent's
// wallet (not its owner's), create a launch and confirm the creator allocation lands there
// too, then claim and confirm the sweep back to the owner. Requires the indexer (`pnpm dev`)
// to already be running against this same local-test-validator, since wallet provisioning is
// entirely its responsibility (see apps/indexer/src/listeners/solana.ts).

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL || "http://127.0.0.1:8899";

  const recordPath = path.resolve(__dirname, "../../../packages/contracts-solana/scripts/local-dev/local-devnet.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
    programId: string;
    usdcMint: string;
    treasuryAddress: string;
  };

  const mintAuthority = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME || "", ".config/solana/id.json"), "utf8"))),
  );

  const connection = new (await import("@solana/web3.js")).Connection(rpcUrl, "confirmed");
  const usdcMint = new PublicKey(record.usdcMint);

  console.log("=== Setup: fresh agentOwner + employer keypairs ===");
  const agentOwner = Keypair.generate();
  const employer = Keypair.generate();
  for (const kp of [agentOwner, employer]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }
  console.log(`agentOwner: ${agentOwner.publicKey.toBase58()}`);
  console.log(`employer:   ${employer.publicKey.toBase58()}`);

  const employerUsdcAta = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, usdcMint, employer.publicKey);
  await mintTo(connection, mintAuthority, usdcMint, employerUsdcAta.address, mintAuthority, 1_000_000_000); // 1,000 USDC

  const makeAdapter = (signer: Keypair) => {
    const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
    return new SolanaAdapter({
      programId: record.programId,
      connection,
      provider,
      usdcMint,
      treasuryAddress: new PublicKey(record.treasuryAddress),
    });
  };
  const ownerAdapter = makeAdapter(agentOwner);
  const employerAdapter = makeAdapter(employer);

  console.log("\n=== Step 1: register a fresh agent ===");
  const protocolBefore = await ownerAdapter.getProtocolStats();
  const agentId = Number(protocolBefore.totalAgents) + 1; // next_agent_id tracks 1 past total registered so far this run
  await ownerAdapter.registerAgent({
    owner: agentOwner.publicKey,
    agentId,
    name: `verify-agent-${Date.now()}`,
    agentUri: "ipfs://verify",
    endpoint: "https://verify.example",
    metadataHash: new Array(32).fill(0),
    supportsX402: true,
    supportsA2A: true,
    supportsMcp: true,
  });
  console.log(`Registered agent #${agentId}, owner ${agentOwner.publicKey.toBase58()}`);

  console.log("\n=== Step 2: wait for indexer to auto-provision the agent wallet ===");
  let agentWalletAddress: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3000);
    const agent = await ownerAdapter.getAgent(agentId);
    const wallet = agent.agentWallet as PublicKey;
    if (!wallet.equals(PublicKey.default)) {
      agentWalletAddress = wallet.toBase58();
      break;
    }
    console.log(`  ...not yet provisioned (attempt ${attempt + 1}/20)`);
  }
  if (!agentWalletAddress) throw new Error("Agent wallet was never provisioned — is the indexer running against this validator?");
  console.log(`Agent wallet provisioned on-chain: ${agentWalletAddress}`);

  console.log("\n=== Step 3: post + complete a job, verify payout lands in the agent wallet ===");
  const protocolForJob = await ownerAdapter.getProtocolStats();
  const jobId = Number(protocolForJob.totalJobs) + 1;
  const jobBudget = 50_000_000n; // 50 USDC
  await employerAdapter.postJob({
    employer: employer.publicKey,
    employerAgentId: 0,
    hiredAgentId: agentId,
    jobId,
    taskHash: new Array(32).fill(1),
    budget: jobBudget,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  });
  await ownerAdapter.acceptJob(agentOwner.publicKey, agentId, jobId);
  await ownerAdapter.submitDeliverable(agentOwner.publicKey, agentId, jobId, new Array(32).fill(2));

  const walletUsdcBalanceBefore = await readAgentWalletBalance(CHAIN, agentWalletAddress);
  const ownerUsdcAtaAddr = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, usdcMint, agentOwner.publicKey);
  const ownerUsdcBefore = (await getAccount(connection, ownerUsdcAtaAddr.address)).amount;

  await employerAdapter.confirmDelivery({ employer: employer.publicKey, agentId, jobId, rating: 5 });

  const walletUsdcBalanceAfter = await readAgentWalletBalance(CHAIN, agentWalletAddress);
  const ownerUsdcAfter = (await getAccount(connection, ownerUsdcAtaAddr.address)).amount;

  console.log(`Agent wallet USDC: ${walletUsdcBalanceBefore} -> ${walletUsdcBalanceAfter} (expected +${jobBudget})`);
  console.log(`Owner USDC:        ${ownerUsdcBefore} -> ${ownerUsdcAfter} (expected unchanged)`);
  if (walletUsdcBalanceAfter !== (walletUsdcBalanceBefore ?? 0n) + jobBudget) throw new Error("FAIL: job payout did not land in agent wallet");
  if (ownerUsdcAfter !== ownerUsdcBefore) throw new Error("FAIL: owner balance changed — payout leaked to owner instead of agent wallet");
  console.log("PASS: job payout redirected to agent wallet, owner untouched.");

  console.log("\n=== Step 4: create a launch, verify creator allocation lands in the agent wallet ===");
  const protocolForLaunch = await ownerAdapter.getProtocolStats();
  const launchId = Number(protocolForLaunch.totalLaunches) + 1;
  const tokenMint = Keypair.generate();
  const creatorAllocBps = 500; // 5%
  await ownerAdapter.createLaunch({
    creator: agentOwner.publicKey,
    agentId,
    launchId,
    name: "Verify Token",
    symbol: "VFY",
    creatorAllocBps,
    tokenMint,
  });

  const agentWalletPubkey = new PublicKey(agentWalletAddress);
  const creatorTokenAta = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint.publicKey, agentWalletPubkey);
  const creatorTokenBalance = (await getAccount(connection, creatorTokenAta.address)).amount;
  const ownerTokenAtaAddr = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint.publicKey, agentOwner.publicKey);
  const ownerTokenBalance = (await getAccount(connection, ownerTokenAtaAddr.address)).amount;

  const totalSupply = 1_000_000_000n * 1_000_000_000n; // TOTAL_AGENT_TOKEN_SUPPLY_WHOLE * 10^9 decimals (math.rs: TOKEN_DECIMALS = 9)
  const expectedCreatorAmount = (totalSupply * BigInt(creatorAllocBps)) / 10_000n;
  console.log(`Agent wallet token balance: ${creatorTokenBalance} (expected ${expectedCreatorAmount})`);
  console.log(`Owner token balance:        ${ownerTokenBalance} (expected 0)`);
  if (creatorTokenBalance !== expectedCreatorAmount) throw new Error("FAIL: creator allocation did not land in agent wallet");
  if (ownerTokenBalance !== 0n) throw new Error("FAIL: creator allocation leaked to owner instead of agent wallet");
  console.log("PASS: launch creator allocation redirected to agent wallet, owner untouched.");

  console.log("\n=== Step 5: claim — sweep agent wallet's USDC back to the owner ===");
  const claimResult = await claimAgentWallet(CHAIN, agentId.toString(), agentOwner.publicKey.toBase58());
  console.log("Claim result:", claimResult);

  const walletUsdcAfterClaim = await readAgentWalletBalance(CHAIN, agentWalletAddress);
  const ownerUsdcAfterClaim = (await getAccount(connection, ownerUsdcAtaAddr.address)).amount;
  console.log(`Agent wallet USDC after claim: ${walletUsdcAfterClaim} (expected 0)`);
  console.log(`Owner USDC after claim:        ${ownerUsdcAfterClaim} (expected ${ownerUsdcAfter + jobBudget})`);
  if (walletUsdcAfterClaim !== 0n) throw new Error("FAIL: agent wallet still holds USDC after claim");
  if (ownerUsdcAfterClaim !== ownerUsdcAfter + jobBudget) throw new Error("FAIL: claimed funds did not land in owner's wallet");
  console.log("PASS: claim swept the agent wallet's full USDC balance to the current owner.");

  console.log("\n=== ALL CHECKS PASSED ===");
}

main().catch((error) => {
  console.error("\n=== VERIFICATION FAILED ===");
  console.error(error);
  process.exitCode = 1;
});
