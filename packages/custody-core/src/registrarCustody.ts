import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { prisma, RegistrarWalletStatus, type RegistrarWallet, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import { isSolanaPrismaChain } from "./solanaChainConfig.js";
import { isSuiPrismaChain } from "./suiChainConfig.js";

// Registrar custody: the indexer's privileged signer that calls setAgentWallet (EVM:
// AgentWalletRegistry.setAgentWallet; Solana: clawdhq_agent's set_agent_wallet instruction;
// Sui: registry::set_agent_wallet) once custody-core has provisioned an agent's canonical
// AgentWallet — one signer per chain, same "no capital-bounding reason to mint a fresh one per
// call" shape as the x402 facilitator's signer (facilitatorCustody.ts), since this wallet never
// holds funds either, it only submits a privileged write (plus, on Solana, sponsors a freshly
// provisioned AgentWallet's own ATA rent — see ensureUsdcAtaFor). Uses its own root key
// (REGISTRAR_KMS_PROVIDER/REGISTRAR_LOCAL_ROOT_KEY, separate from every other domain) so a
// compromise of one custodied-signing domain doesn't expose the others. Chain-dispatch for
// keypair generation mirrors agentWalletCustody.ts's provisionAgentWallet exactly. The chain's
// admin must separately rotate this wallet's address in as the on-chain registrar authority
// (EVM: AgentWalletRegistry.setRegistrar; Solana: clawdhq_agent's set_registrar instruction) —
// see contracts-evm's local-dev deploy-and-seed.ts and apps/indexer/scripts/
// rotate-local-registrar*.ts. Provisioning this wallet does not itself grant any on-chain
// authority.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust once this
// key is rotated in as registrar against a contract holding real agents.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.REGISTRAR_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("REGISTRAR_LOCAL_ROOT_KEY");
  throw new Error(
    `REGISTRAR_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before rotating this signer in as registrar in production.",
  );
}

async function encryptPrivateKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptPrivateKey(encryptedPrivateKey: string): Promise<string> {
  return decryptWithProvider(encryptedPrivateKey, getRootKeyProvider());
}

function generateEvmWallet(): { address: string; secretMaterial: string } {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, secretMaterial: privateKey };
}

function generateSolanaWallet(): { address: string; secretMaterial: string } {
  const keypair = Keypair.generate();
  return { address: keypair.publicKey.toBase58(), secretMaterial: bs58.encode(keypair.secretKey) };
}

function generateSuiWallet(): { address: string; secretMaterial: string } {
  const keypair = Ed25519Keypair.generate();
  return { address: keypair.toSuiAddress(), secretMaterial: keypair.getSecretKey() };
}

/** Idempotent: returns the chain's existing registrar wallet rather than provisioning a second
 * one. */
export async function getOrCreateRegistrarWallet(chain: Chain): Promise<RegistrarWallet> {
  const existing = await prisma.registrarWallet.findFirst({ where: { chain } });
  if (existing) return existing;

  const generated = isSolanaPrismaChain(chain) ? generateSolanaWallet() : isSuiPrismaChain(chain) ? generateSuiWallet() : generateEvmWallet();
  const encryptedPrivateKey = await encryptPrivateKey(generated.secretMaterial);

  try {
    return await prisma.registrarWallet.create({
      data: { chain, address: generated.address, encryptedPrivateKey, keyVersion: 1, status: RegistrarWalletStatus.ACTIVE },
    });
  } catch {
    const winner = await prisma.registrarWallet.findFirst({ where: { chain } });
    if (!winner) throw new Error(`Failed to provision or find a RegistrarWallet for ${chain}`);
    return winner;
  }
}

/** Decrypted key material, for transient use signing a single setAgentWallet call — callers
 * must not log or persist the returned privateKey. Its encoding depends on the wallet's chain
 * family (hex for EVM, base58 secret key for Solana, Bech32 secret key for Sui). Returns null
 * if no registrar wallet has been provisioned for this chain yet. */
export async function getDecryptedRegistrarWallet(chain: Chain): Promise<{ address: string; privateKey: string } | null> {
  const wallet = await prisma.registrarWallet.findFirst({ where: { chain } });
  if (!wallet || wallet.status !== RegistrarWalletStatus.ACTIVE) return null;
  return { address: wallet.address, privateKey: await decryptPrivateKey(wallet.encryptedPrivateKey) };
}
