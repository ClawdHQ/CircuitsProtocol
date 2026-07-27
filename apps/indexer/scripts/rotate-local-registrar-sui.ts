import "../src/loadEnv.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiAdapter } from "@clawdhq/sdk";
import { getOrCreateRegistrarWallet, suiClientFor, suiPackageIdFor, suiProtocolStateIdFor, suiUsdcCoinTypeFor, signAndExecuteSui } from "@clawdhq/custody-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local-devnet-only bootstrap: registry.move's ProtocolState.registrar is initialized to
// `authority` as a placeholder (see registry.move's `init` doc comment) — the indexer's actual
// privileged signer doesn't exist until custody-core provisions it at runtime. This script
// provisions that real wallet (idempotent — safe to re-run), rotates it in via
// registry::set_registrar, and funds it with local SUI for transaction fees + the gas top-ups it
// sponsors for agent-wallet claims (see custody-core's ensureSuiGasForClaim), so the indexer's
// provisionAgentWalletOnChain can actually submit set_agent_wallet transactions. Mirrors this
// same script's EVM/Solana siblings (rotate-local-registrar.ts / rotate-local-registrar-solana.ts).

const CHAIN = "SUI_TESTNET" as const;

/** Sui's CLI keystore (~/.sui/sui_config/sui.keystore) stores each key as base64(flag_byte ++
 * 32-byte secret) — a different encoding from the Bech32 `suiprivkey1...` format
 * Ed25519Keypair.fromSecretKey's string overload expects, so this decodes it by hand rather
 * than reusing keypairFromSuiSecret (which is for custody-core's own Bech32-encoded storage). */
function keypairFromKeystoreEntry(base64Entry: string): Ed25519Keypair {
  const decoded = Buffer.from(base64Entry, "base64");
  const secretKey = decoded.subarray(1); // drop the 1-byte scheme flag
  return Ed25519Keypair.fromSecretKey(secretKey);
}

async function main() {
  const keystorePath = path.join(process.env.HOME || "", ".sui/sui_config/sui.keystore");
  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf8")) as string[];
  const authority = keypairFromKeystoreEntry(keystore[0]);
  console.log(`Local Sui CLI authority address: ${authority.toSuiAddress()}`);

  const client = suiClientFor(CHAIN);
  const packageId = suiPackageIdFor(CHAIN);
  const protocolStateId = suiProtocolStateIdFor(CHAIN);
  const adapter = new SuiAdapter({ packageId, client, protocolStateId, usdcCoinType: suiUsdcCoinTypeFor(CHAIN) });

  const protocolObject = await adapter.getObject(protocolStateId);
  const fields = (protocolObject.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const onChainAuthority = String(fields?.authority ?? "");
  if (onChainAuthority.toLowerCase() !== authority.toSuiAddress().toLowerCase()) {
    throw new Error(
      `Derived authority ${authority.toSuiAddress()} doesn't match ProtocolState.authority ${onChainAuthority} — ` +
        "is this really the local Sui network this package was published to?",
    );
  }

  console.log(`Provisioning the real registrar wallet for ${CHAIN}...`);
  const registrarWallet = await getOrCreateRegistrarWallet(CHAIN);
  console.log(`Registrar wallet: ${registrarWallet.address}`);

  const currentRegistrar = String(fields?.registrar ?? "");
  if (currentRegistrar.toLowerCase() !== registrarWallet.address.toLowerCase()) {
    console.log(`Rotating registrar: ${currentRegistrar} -> ${registrarWallet.address}...`);
    const tx = adapter.setRegistrar(registrarWallet.address);
    await signAndExecuteSui(CHAIN, authority, tx);
  } else {
    console.log("Registrar already rotated in — skipping.");
  }

  const { totalBalance } = await client.getBalance({ owner: registrarWallet.address });
  const minBalance = 1_000_000_000n; // 1 SUI
  if (BigInt(totalBalance) < minBalance) {
    console.log("Funding registrar wallet with local SUI for fees + claim gas top-ups...");
    const tx = new Transaction();
    const [funding] = tx.splitCoins(tx.gas, [2_000_000_000n]); // 2 SUI
    tx.transferObjects([funding], registrarWallet.address);
    await signAndExecuteSui(CHAIN, authority, tx);
  }

  console.log("Registrar wallet ready:", registrarWallet.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
