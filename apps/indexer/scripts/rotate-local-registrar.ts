import "../src/loadEnv.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { getOrCreateRegistrarWallet, viemChainFor, rpcUrlFor, type EvmPrismaChain } from "@clawdhq/custody-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local-devnet-only bootstrap: AgentWalletRegistry.sol is deployed with `admin` as a
// placeholder registrar (see contracts-evm/scripts/local-dev/deploy-and-seed.ts's comment) —
// the indexer's actual privileged signer doesn't exist until custody-core provisions it at
// runtime. This script provisions that real wallet (idempotent — safe to re-run), rotates it
// in via AgentWalletRegistry.setRegistrar, and funds it with local ETH for gas, so the
// indexer's provisionAgentWalletOnChain can actually submit setAgentWallet transactions.
//
// Mirrors X402Facilitator's equivalent "rotate the real signer in" step — except that one was
// never actually automated anywhere in this codebase (a real, pre-existing gap, confirmed by
// grepping for setFacilitator( outside tests). This script closes the same gap for the
// registrar signer, since the AgentWalletRegistry integration can't be verified end-to-end
// without it.

const CHAIN: EvmPrismaChain = "BSC_TESTNET"; // local devnet always points this chain's RPC at localhost

// Hardhat/Anvil's universally-documented default local dev mnemonic — never used for anything
// but a local, throwaway devnet. Account index 0 is `admin` in deploy-and-seed.ts (Hardhat's
// own default signer ordering).
const LOCAL_ADMIN_MNEMONIC = "test test test test test test test test test test test junk";

async function main() {
  const recordPath = path.resolve(__dirname, "../../../packages/contracts-evm/scripts/local-dev/local-devnet.json");
  if (!fs.existsSync(recordPath)) {
    throw new Error(`${recordPath} not found — run deploy-and-seed.ts first.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { registryAddress: string; accounts: { admin: string } };

  const admin = mnemonicToAccount(LOCAL_ADMIN_MNEMONIC, { addressIndex: 0 });
  if (admin.address.toLowerCase() !== record.accounts.admin.toLowerCase()) {
    throw new Error(
      `Derived admin address ${admin.address} doesn't match local-devnet.json's ${record.accounts.admin} — ` +
        "is this really the local Hardhat devnet's default mnemonic?"
    );
  }

  console.log(`Provisioning the real registrar wallet for ${CHAIN}...`);
  const registrarWallet = await getOrCreateRegistrarWallet(CHAIN);
  console.log(`Registrar wallet: ${registrarWallet.address}`);

  const viemChain = viemChainFor(CHAIN);
  const transport = http(rpcUrlFor(CHAIN));
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient = createWalletClient({ account: admin, chain: viemChain, transport });

  const registryAbi = parseAbi(["function setRegistrar(address newRegistrar) external", "function registrar() view returns (address)"]);
  const currentRegistrar = (await publicClient.readContract({
    address: record.registryAddress as `0x${string}`,
    abi: registryAbi,
    functionName: "registrar",
  })) as `0x${string}`;

  if (currentRegistrar.toLowerCase() !== registrarWallet.address.toLowerCase()) {
    console.log(`Rotating registrar: ${currentRegistrar} -> ${registrarWallet.address}...`);
    const hash = await walletClient.writeContract({
      address: record.registryAddress as `0x${string}`,
      abi: registryAbi,
      functionName: "setRegistrar",
      args: [registrarWallet.address as `0x${string}`],
      account: admin,
      chain: viemChain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  } else {
    console.log("Registrar already rotated in — skipping.");
  }

  const balance = await publicClient.getBalance({ address: registrarWallet.address as `0x${string}` });
  const minBalance = 1_000_000_000_000_000_000n; // 1 ETH — this is a local devnet, gas is free
  if (balance < minBalance) {
    console.log(`Funding registrar wallet with local ETH for gas...`);
    const hash = await walletClient.sendTransaction({
      account: admin,
      chain: viemChain,
      to: registrarWallet.address as `0x${string}`,
      value: minBalance,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  console.log("Registrar wallet ready:", registrarWallet.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
