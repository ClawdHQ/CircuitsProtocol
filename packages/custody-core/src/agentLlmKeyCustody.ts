import { prisma, WalletStatus, LlmProvider, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";

// BYO LLM provider key for a hosted-runtime agent (see packages/hosted-agent-runtime) — not
// custodied funds, but still secret material this app decrypts to call an LLM on the owner's
// behalf server-side, so it gets the same envelope-encryption treatment as every wallet in this
// package. Own root key (LLM_KEY_KMS_PROVIDER/LLM_KEY_LOCAL_ROOT_KEY), isolated from every
// wallet domain's root key for the same reason those are isolated from each other — see
// agentWalletCustody.ts's doc comment.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust for a key
// that unlocks real spend against a real provider account. LLM_KEY_KMS_PROVIDER must point at a
// real KMS before any agent's own LLM key is stored for real.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.LLM_KEY_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("LLM_KEY_LOCAL_ROOT_KEY");
  throw new Error(
    `LLM_KEY_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before storing any agent's LLM key in production.",
  );
}

async function encryptApiKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptApiKey(encryptedApiKey: string): Promise<string> {
  return decryptWithProvider(encryptedApiKey, getRootKeyProvider());
}

/** Stores (or replaces) the LLM provider key an owner supplied for their hosted-runtime agent.
 * Unlike provisionAgentWallet, this always overwrites — an owner rotating their key expects the
 * old one gone, not idempotently preserved. `keyVersion` still increments so a decrypt failure
 * against an old envelope after a root-key rotation is at least diagnosable. */
export async function saveAgentLlmKey(chain: Chain, agentChainId: string, provider: LlmProvider, plaintextApiKey: string): Promise<void> {
  const encryptedApiKey = await encryptApiKey(plaintextApiKey);
  const existing = await prisma.agentLlmKey.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });

  await prisma.agentLlmKey.upsert({
    where: { chain_agentChainId: { chain, agentChainId } },
    create: { chain, agentChainId, provider, encryptedApiKey, keyVersion: 1, status: WalletStatus.ACTIVE },
    update: { provider, encryptedApiKey, keyVersion: (existing?.keyVersion ?? 0) + 1, status: WalletStatus.ACTIVE },
  });
}

/** True if an owner has stored a usable LLM key for this agent — checked before switching an
 * agent's runtime config to BYO_KEY billing, so that choice can't be saved with nothing behind
 * it. */
export async function hasActiveAgentLlmKey(chain: Chain, agentChainId: string): Promise<boolean> {
  const key = await prisma.agentLlmKey.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  return Boolean(key && key.status === WalletStatus.ACTIVE);
}

/** Decrypted key material, for transient use calling the LLM provider for a single request —
 * callers must not log or persist the returned apiKey. Returns null if no key has been stored
 * for this agent or it was revoked. */
export async function getDecryptedAgentLlmKey(chain: Chain, agentChainId: string): Promise<{ provider: LlmProvider; apiKey: string } | null> {
  const key = await prisma.agentLlmKey.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!key || key.status !== WalletStatus.ACTIVE) return null;
  return { provider: key.provider, apiKey: await decryptApiKey(key.encryptedApiKey) };
}

/** Revokes a stored key without deleting the row — same "keep the audit trail, stop trusting
 * the key" shape WalletStatus.REVOKED already has for every other custodied secret. */
export async function revokeAgentLlmKey(chain: Chain, agentChainId: string): Promise<void> {
  await prisma.agentLlmKey.updateMany({ where: { chain, agentChainId }, data: { status: WalletStatus.REVOKED } });
}
