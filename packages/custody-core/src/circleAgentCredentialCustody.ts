import { prisma, type CircleAgentWalletCredential } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";

// An owner's own Circle API key + entity secret, supplied when onboarding a pre-existing Circle
// Agent Wallet (see agentEvmSigner.ts, circleAgentSignerProvider.ts) instead of using an
// auto-provisioned AgentWallet. Unlike agentWalletCustody.ts's private keys, this secret pair
// authorizes at the *account* level — Circle's Developer-Controlled Wallets API has no
// wallet-scoped credential, so this key unlocks every wallet under the owner's Circle entity,
// not just the one being onboarded (see CircleAgentWalletCredential's own schema doc comment).
// Own root key (AGENT_CIRCLE_CREDENTIAL_KMS_PROVIDER/AGENT_CIRCLE_CREDENTIAL_LOCAL_ROOT_KEY),
// isolated from every other custody domain's root key for the same reason those are isolated
// from each other.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust for a
// secret this powerful. AGENT_CIRCLE_CREDENTIAL_KMS_PROVIDER must point at a real KMS before any
// owner's real Circle credentials are stored.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.AGENT_CIRCLE_CREDENTIAL_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("AGENT_CIRCLE_CREDENTIAL_LOCAL_ROOT_KEY");
  throw new Error(
    `AGENT_CIRCLE_CREDENTIAL_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before storing any owner's Circle credentials in production.",
  );
}

async function encryptSecret(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptSecret(ciphertext: string): Promise<string> {
  return decryptWithProvider(ciphertext, getRootKeyProvider());
}

export interface CircleCredentialInput {
  apiKey: string;
  entitySecret: string;
}

/** Stores (or replaces) the Circle credentials an owner supplied. Always overwrites, same
 * "rotation expects the old one gone" reasoning as saveAgentLlmKey — an owner pasting a new key
 * expects it to take effect, not sit alongside the old one. */
export async function saveCircleAgentWalletCredential(ownerAddress: string, credential: CircleCredentialInput): Promise<CircleAgentWalletCredential> {
  const [encryptedApiKey, encryptedEntitySecret] = await Promise.all([encryptSecret(credential.apiKey), encryptSecret(credential.entitySecret)]);
  const existing = await prisma.circleAgentWalletCredential.findUnique({ where: { ownerAddress } });

  return prisma.circleAgentWalletCredential.upsert({
    where: { ownerAddress },
    create: { ownerAddress, encryptedApiKey, encryptedEntitySecret, keyVersion: 1 },
    update: { encryptedApiKey, encryptedEntitySecret, keyVersion: (existing?.keyVersion ?? 0) + 1 },
  });
}

/** Decrypted credentials, for transient use constructing a Circle client for a single operation
 * — callers must not log or persist the returned values. Throws if the id doesn't resolve (a
 * dangling circleCredentialId would mean an AgentWallet row is unsignable, worth surfacing
 * loudly rather than silently treating as "no wallet"). */
export async function getDecryptedCircleAgentWalletCredential(id: string): Promise<CircleCredentialInput> {
  const credential = await prisma.circleAgentWalletCredential.findUnique({ where: { id } });
  if (!credential) throw new Error(`CircleAgentWalletCredential ${id} not found`);
  const [apiKey, entitySecret] = await Promise.all([decryptSecret(credential.encryptedApiKey), decryptSecret(credential.encryptedEntitySecret)]);
  return { apiKey, entitySecret };
}

/** Id only — resolved once at onboarding time and stored on AgentWallet/PendingCircleAgentWalletIntent,
 * never re-derived from ownerAddress at sign time (an owner could rotate their stored credential
 * for future onboarding without retroactively changing which secret an already-onboarded
 * agent's wallet signs with). */
export async function getCircleAgentWalletCredentialId(ownerAddress: string): Promise<string | null> {
  const credential = await prisma.circleAgentWalletCredential.findUnique({ where: { ownerAddress }, select: { id: true } });
  return credential?.id ?? null;
}
