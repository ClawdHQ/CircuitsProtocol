import "../src/loadEnv.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiAdapter } from "@clawdhq/sdk";
import {
  suiClientFor,
  suiPackageIdFor,
  suiProtocolStateIdFor,
  suiUsdcCoinTypeFor,
  signAndExecuteSui,
  retryOnFreshObjectLag,
  claimAgentWallet,
  readAgentWalletBalance,
} from "@clawdhq/custody-core";

const CHAIN = "SUI_TESTNET" as const;

// End-to-end proof (mirrors verify-solana-e2e.ts) that the universal agent wallet redirect
// works on Sui: register a fresh agent, confirm the indexer auto-provisions its wallet,
// complete a job and confirm the payout lands in the agent's wallet (not its owner's), create a
// launch and confirm the creator allocation lands there too, then claim and confirm the sweep
// back to the owner. Requires the Sui listener (run-sui-only.ts, or the full `pnpm dev`) to
// already be running against this same local network, since wallet provisioning is entirely its
// responsibility (see apps/indexer/src/listeners/sui.ts).

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isZeroSuiAddress(value: string): boolean {
  return /^0x0*$/.test(value);
}

/** Polls a balance read until it matches `expected` or the attempts run out, returning
 * whatever the last read was either way — same read-lag reasoning as the agent_id retry loop
 * below (a plain balance query, not a PTB-build issue), confirmed by direct `sui client
 * balance` CLI reads landing correctly on-chain immediately while this SDK-side read still
 * momentarily returned stale data. */
async function readBalanceUntil(read: () => Promise<bigint>, expected: bigint, attempts = 10, delayMs = 800): Promise<bigint> {
  let value = await read();
  for (let attempt = 0; attempt < attempts && value !== expected; attempt++) {
    await sleep(delayMs);
    value = await read();
  }
  return value;
}

function keypairFromKeystoreEntry(base64Entry: string): Ed25519Keypair {
  const decoded = Buffer.from(base64Entry, "base64");
  return Ed25519Keypair.fromSecretKey(decoded.subarray(1));
}

async function main() {
  const client = suiClientFor(CHAIN);
  const packageId = suiPackageIdFor(CHAIN);
  const protocolStateId = suiProtocolStateIdFor(CHAIN);
  const usdcCoinType = suiUsdcCoinTypeFor(CHAIN);
  const adapter = new SuiAdapter({ packageId, client, protocolStateId, usdcCoinType });

  const keystorePath = path.join(process.env.HOME || "", ".sui/sui_config/sui.keystore");
  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf8")) as string[];
  const authority = keypairFromKeystoreEntry(keystore[0]);

  const treasuryCaps = await client.getOwnedObjects({
    owner: authority.toSuiAddress(),
    filter: { StructType: `0x2::coin::TreasuryCap<${usdcCoinType}>` },
  });
  const treasuryCapId = treasuryCaps.data[0]?.data?.objectId;
  if (!treasuryCapId) throw new Error("Couldn't find the USDC TreasuryCap owned by the local CLI authority.");

  console.log("=== Setup: fresh agentOwner + employer keypairs, funded with SUI + USDC ===");
  const agentOwner = Ed25519Keypair.generate();
  const employer = Ed25519Keypair.generate();
  console.log(`agentOwner: ${agentOwner.toSuiAddress()}`);
  console.log(`employer:   ${employer.toSuiAddress()}`);

  const setupTx = new Transaction();
  const [ownerGas] = setupTx.splitCoins(setupTx.gas, [1_000_000_000n]); // 1 SUI each
  const [employerGas] = setupTx.splitCoins(setupTx.gas, [1_000_000_000n]);
  setupTx.transferObjects([ownerGas], agentOwner.toSuiAddress());
  setupTx.transferObjects([employerGas], employer.toSuiAddress());
  setupTx.moveCall({
    target: `${packageId}::usdc::mint`,
    arguments: [setupTx.object(treasuryCapId), setupTx.pure.u64(1_000n), setupTx.pure.address(agentOwner.toSuiAddress())],
  });
  setupTx.moveCall({
    target: `${packageId}::usdc::mint`,
    arguments: [setupTx.object(treasuryCapId), setupTx.pure.u64(1_000n), setupTx.pure.address(agentOwner.toSuiAddress())],
  });
  setupTx.moveCall({
    target: `${packageId}::usdc::mint`,
    arguments: [setupTx.object(treasuryCapId), setupTx.pure.u64(50_000_000n), setupTx.pure.address(employer.toSuiAddress())],
  });
  const setupResult = await signAndExecuteSui(CHAIN, authority, setupTx);

  // Read the freshly-minted coins straight off this same transaction's own objectChanges
  // rather than a separate getCoins() call — the read RPC can briefly lag behind a
  // just-finalized transaction's effects (same "fresh object lag" signingSuiAdapter.ts's
  // retryOnFreshObjectLag documents), and every coin this transaction created is already
  // right here in its result, no re-query needed.
  const coinType = `0x2::coin::Coin<${usdcCoinType}>`;
  const createdCoins = (setupResult.objectChanges ?? []).filter(
    (c): c is Extract<typeof c, { type: "created" }> => c.type === "created" && "objectType" in c && c.objectType === coinType,
  );
  const ownerCoinIds = createdCoins.filter((c) => "owner" in c && JSON.stringify(c.owner).includes(agentOwner.toSuiAddress())).map((c) => c.objectId);
  const employerCoinIds = createdCoins.filter((c) => "owner" in c && JSON.stringify(c.owner).includes(employer.toSuiAddress())).map((c) => c.objectId);
  const [registerFeeCoin, launchFeeCoin] = ownerCoinIds;
  const jobBudgetCoin = employerCoinIds[0];
  if (!registerFeeCoin || !launchFeeCoin || !jobBudgetCoin) throw new Error("Couldn't resolve minted USDC coin ids from the setup transaction's objectChanges.");

  console.log("\n=== Step 1: register a fresh agent ===");
  // Wrapped in retryOnFreshObjectLag: registerFeeCoin was created moments ago by the setup
  // transaction above, and object-reference resolution can briefly lag behind a just-finalized
  // transaction's effects (see signingSuiAdapter.ts's doc comment on this same helper).
  const registerResult = await retryOnFreshObjectLag(async () => {
    const registerTx = new Transaction();
    const agent = registerTx.moveCall({
      target: `${packageId}::registry::register_agent`,
      arguments: [
        registerTx.object(protocolStateId),
        registerTx.pure.string(`verify-agent-${Date.now()}`),
        registerTx.pure.string("ipfs://verify"),
        registerTx.pure.string("https://verify.example"),
        registerTx.pure.vector("u8", new Array(32).fill(0)),
        registerTx.pure.bool(true),
        registerTx.pure.bool(true),
        registerTx.pure.bool(true),
        registerTx.object(registerFeeCoin),
        registerTx.object.clock(),
      ],
    });
    registerTx.moveCall({ target: "0x2::transfer::public_share_object", typeArguments: [`${packageId}::registry::Agent`], arguments: [agent] });
    registerTx.setSender(agentOwner.toSuiAddress());
    const result = await client.signAndExecuteTransaction({
      transaction: registerTx,
      signer: agentOwner,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status.status !== "success") throw new Error(`register_agent failed: ${result.effects?.status.error}`);
    return result;
  });
  const agentObjectId = registerResult.objectChanges?.find(
    (c) => c.type === "created" && "objectType" in c && c.objectType.endsWith("::registry::Agent"),
  );
  if (!agentObjectId || !("objectId" in agentObjectId)) throw new Error("Couldn't resolve the new Agent's object id.");
  console.log(`Registered agent, object id ${agentObjectId.objectId}, owner ${agentOwner.toSuiAddress()}`);

  // Same fresh-object-read lag as elsewhere in this script — a plain getObject just after
  // this same process created the object, not a PTB-build issue, so retryOnFreshObjectLag
  // (which only retries a specific build-time error message) doesn't apply here directly.
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 10 && !agentId; attempt++) {
    const content = (await adapter.getObject(agentObjectId.objectId)).data?.content as { fields?: Record<string, unknown> } | undefined;
    agentId = content?.fields?.agent_id !== undefined ? String(content.fields.agent_id) : undefined;
    if (!agentId) await sleep(500);
  }
  if (!agentId) throw new Error("Couldn't read the new Agent's agent_id field.");
  console.log(`Numeric agent_id: ${agentId}`);

  console.log("\n=== Step 2: wait for indexer to auto-provision the agent wallet ===");
  let agentWalletAddress: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3000);
    const current = await adapter.getAgentByChainId(BigInt(agentId));
    const wallet = String(current?.fields.agent_wallet ?? "0x0");
    if (!isZeroSuiAddress(wallet)) {
      agentWalletAddress = wallet;
      break;
    }
    console.log(`  ...not yet provisioned (attempt ${attempt + 1}/20)`);
  }
  if (!agentWalletAddress) throw new Error("Agent wallet was never provisioned — is the Sui indexer listener running against this network?");
  console.log(`Agent wallet provisioned on-chain: ${agentWalletAddress}`);

  console.log("\n=== Step 3: post + complete a job, verify payout lands in the agent wallet ===");
  const deadlineMs = Date.now() + 3_600_000;
  const postJobResult = await retryOnFreshObjectLag(() =>
    signAndExecuteSui(
      CHAIN,
      employer,
      adapter.postJob({ hiredAgentId: agentObjectId.objectId, employerAgentId: 0, taskHash: new Array(32).fill(1), budgetCoin: jobBudgetCoin, deadlineMs }),
    ),
  );
  const jobObjectId = postJobResult.objectChanges?.find((c) => c.type === "created" && "objectType" in c && c.objectType.endsWith("::marketplace::Job"));
  if (!jobObjectId || !("objectId" in jobObjectId)) throw new Error("Couldn't resolve the new Job's object id.");
  await sleep(1000);

  // A short settle delay between each pair of transactions that chain off the same shared
  // object (Job/Agent): signAndExecuteSui already waits for on-chain finality (showEffects),
  // but the *read* path used to resolve that object's version when building the *next*
  // transaction can lag slightly behind — unlike the "does not exist" case
  // retryOnFreshObjectLag catches, a stale-but-present version resolves silently and only
  // surfaces as a Move-level assertion failure (e.g. submit_deliverable's ENotActive if it
  // built against a pre-accept_job version of Job). Fine for this local-devnet script; real
  // callers space these out naturally (a human reviewing a job takes longer than 1s).
  await retryOnFreshObjectLag(() => signAndExecuteSui(CHAIN, agentOwner, adapter.acceptJob(jobObjectId.objectId, agentObjectId.objectId)));
  await sleep(1000);
  await retryOnFreshObjectLag(() =>
    signAndExecuteSui(CHAIN, agentOwner, adapter.submitDeliverable(jobObjectId.objectId, agentObjectId.objectId, new Array(32).fill(2))),
  );
  await sleep(1000);

  const walletUsdcBefore = await readAgentWalletBalance(CHAIN, agentWalletAddress);
  const { totalBalance: ownerUsdcBefore } = await client.getBalance({ owner: agentOwner.toSuiAddress(), coinType: usdcCoinType });

  await retryOnFreshObjectLag(() =>
    signAndExecuteSui(CHAIN, employer, adapter.confirmDelivery({ jobId: jobObjectId.objectId, agentId: agentObjectId.objectId, rating: 5 })),
  );

  const jobBudget = 50_000_000n;
  const walletUsdcAfter = await readBalanceUntil(async () => (await readAgentWalletBalance(CHAIN, agentWalletAddress)) ?? 0n, (walletUsdcBefore ?? 0n) + jobBudget);
  const { totalBalance: ownerUsdcAfter } = await client.getBalance({ owner: agentOwner.toSuiAddress(), coinType: usdcCoinType });

  console.log(`Agent wallet USDC: ${walletUsdcBefore} -> ${walletUsdcAfter} (expected +${jobBudget})`);
  console.log(`Owner USDC:        ${ownerUsdcBefore} -> ${ownerUsdcAfter} (expected unchanged)`);
  if (walletUsdcAfter !== (walletUsdcBefore ?? 0n) + jobBudget) throw new Error("FAIL: job payout did not land in agent wallet");
  if (BigInt(ownerUsdcAfter) !== BigInt(ownerUsdcBefore)) throw new Error("FAIL: owner balance changed — payout leaked to owner instead of agent wallet");
  console.log("PASS: job payout redirected to agent wallet, owner untouched.");

  console.log("\n=== Step 4: create a launch, verify creator allocation lands in the agent wallet ===");
  const creatorAllocBps = 500; // 5%
  await retryOnFreshObjectLag(() =>
    signAndExecuteSui(
      CHAIN,
      agentOwner,
      adapter.createLaunch({ agentId: agentObjectId.objectId, name: "Verify Token", symbol: "VFY", creatorAllocBps, feeCoin: launchFeeCoin }),
    ),
  );
  await sleep(1500);

  const walletPositions = await client.getOwnedObjects({
    owner: agentWalletAddress,
    filter: { StructType: `${packageId}::launchpad::LaunchPosition` },
    options: { showContent: true },
  });
  const ownerPositions = await client.getOwnedObjects({
    owner: agentOwner.toSuiAddress(),
    filter: { StructType: `${packageId}::launchpad::LaunchPosition` },
    options: { showContent: true },
  });

  const totalSupply = 1_000_000_000n * 1_000_000_000n; // TOTAL_AGENT_TOKEN_SUPPLY_WHOLE * TOKEN_DECIMALS_FACTOR (math.move)
  const expectedCreatorAmount = (totalSupply * BigInt(creatorAllocBps)) / 10_000n;
  const walletPositionFields = walletPositions.data[0]?.data?.content as { fields?: Record<string, unknown> } | undefined;
  const walletPositionAmount = BigInt(String(walletPositionFields?.fields?.amount ?? "0"));

  console.log(`Agent wallet LaunchPosition count: ${walletPositions.data.length}, amount: ${walletPositionAmount} (expected ${expectedCreatorAmount})`);
  console.log(`Owner LaunchPosition count:        ${ownerPositions.data.length} (expected 0)`);
  if (walletPositions.data.length !== 1 || walletPositionAmount !== expectedCreatorAmount) throw new Error("FAIL: creator allocation did not land in agent wallet");
  if (ownerPositions.data.length !== 0) throw new Error("FAIL: creator allocation leaked to owner instead of agent wallet");
  console.log("PASS: launch creator allocation redirected to agent wallet, owner untouched.");

  console.log("\n=== Step 5: claim — sweep agent wallet's USDC back to the owner ===");
  const readOwnerUsdc = async () => BigInt((await client.getBalance({ owner: agentOwner.toSuiAddress(), coinType: usdcCoinType })).totalBalance);
  // Baseline captured fresh right before claiming, not reused from Step 3 — Step 4's
  // create_launch call consumed the rest of agentOwner's launchFeeCoin balance in between.
  const ownerUsdcBeforeClaim = await readOwnerUsdc();
  const expectedOwnerAfterClaim = ownerUsdcBeforeClaim + jobBudget;

  const claimResult = await claimAgentWallet(CHAIN, agentId, agentOwner.toSuiAddress());
  console.log("Claim result:", claimResult);

  const walletUsdcAfterClaim = await readBalanceUntil(async () => (await readAgentWalletBalance(CHAIN, agentWalletAddress)) ?? 0n, 0n);
  const ownerUsdcAfterClaim = await readBalanceUntil(readOwnerUsdc, expectedOwnerAfterClaim);
  console.log(`Agent wallet USDC after claim: ${walletUsdcAfterClaim} (expected 0)`);
  console.log(`Owner USDC after claim:        ${ownerUsdcAfterClaim} (expected ${expectedOwnerAfterClaim})`);
  if (walletUsdcAfterClaim !== 0n) throw new Error("FAIL: agent wallet still holds USDC after claim");
  if (ownerUsdcAfterClaim !== expectedOwnerAfterClaim) throw new Error("FAIL: claimed funds did not land in owner's wallet");
  console.log("PASS: claim swept the agent wallet's full USDC balance to the current owner.");

  console.log("\n=== ALL CHECKS PASSED ===");
}

main().catch((error) => {
  console.error("\n=== VERIFICATION FAILED ===");
  console.error(error);
  process.exitCode = 1;
});
