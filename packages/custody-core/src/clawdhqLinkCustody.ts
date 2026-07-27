import { createPublicClient } from "viem";
import { clawdHQCoreAbi } from "@clawdhq/sdk";
import { prisma, WalletStatus, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import { registerClawdHqAgent, linkClawdHqWallet, postToClawdHq, isClawdHqHandleAvailable, clawdHqProfileUrl, circuitsAgentProfileUrl, ClawdHqHandleTakenError } from "./clawdhqClient.js";
import { getAgentWalletAddress } from "./agentWalletCustody.js";
import { viemChainFor, rpcTransportFor, contractAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";

// Own root key (CLAWDHQ_LINK_KMS_PROVIDER/CLAWDHQ_LINK_LOCAL_ROOT_KEY), isolated from every
// other domain's root key for the same reason agentLlmKeyCustody.ts's is — see
// agentWalletCustody.ts's doc comment for the general pattern.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: not
// an acceptable root-of-trust for a real deployment. Swap CLAWDHQ_LINK_KMS_PROVIDER before this
// key protects anything that matters.
function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.CLAWDHQ_LINK_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("CLAWDHQ_LINK_LOCAL_ROOT_KEY");
  throw new Error(`CLAWDHQ_LINK_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only) exists.`);
}

async function encryptApiKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptApiKey(encryptedApiKey: string): Promise<string> {
  return decryptWithProvider(encryptedApiKey, getRootKeyProvider());
}

// Same DiceBear "bottts" formula as apps/web/src/lib/avatar.ts's robotAvatarUrl — duplicated
// rather than imported, since custody-core can't depend on apps/web and this one-line pure
// formula is simpler to keep in sync by hand than to route through an extra parameter. Same
// seed always produces the same avatar, so this and the frontend's copy never actually disagree
// for a given agent name. Only used as a last-resort fallback here — the API route normally
// already resolves the real fallback (or a real upload) before calling connectAgentToClawdHq.
function fallbackAvatarUrl(seed: string): string {
  return `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(seed || "agent")}`;
}

function slugifyHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40); // leave room for a numeric suffix under ClawdHQ's 50-char limit
  return slug || "agent";
}

/** Finds a free ClawdHQ handle starting from `name`'s slug, trying `_2`, `_3`, ... on collision.
 * Not atomic with the real registration (see isClawdHqHandleAvailable's doc comment) — callers
 * still need to handle ClawdHqHandleTakenError from registerClawdHqAgent itself. */
async function findAvailableHandle(name: string): Promise<string> {
  const base = slugifyHandle(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}_${attempt + 1}`;
    if (await isClawdHqHandleAvailable(candidate)) return candidate;
  }
  // Exhausted 20 short-suffix attempts (only plausible for extremely common names) — a random
  // suffix trades a clean handle for a guaranteed one rather than failing the whole connect.
  return `${base}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ClawdHqConnectResult {
  handle: string;
  walletLinked: boolean;
  announcementPosted: boolean;
}

/** Full best-effort ClawdHQ connect flow for a newly registered Circuits Protocol agent:
 * find a free handle, register on ClawdHQ, store the issued API key encrypted, then attempt
 * (but don't block registration on) linking this agent's existing on-chain wallet and posting
 * a one-time introductory announcement. Called once, right after on-chain registration confirms
 * — same "best-effort, agent is already live on-chain regardless" philosophy as persona/
 * hosted-runtime setup in RegisterWizard.tsx. Idempotent-ish: re-running for an agent that
 * already has an ACTIVE link is a no-op (returns its existing state) rather than double-registering. */
export async function connectAgentToClawdHq(
  chain: Chain,
  agentChainId: string,
  params: { name: string; description?: string; avatarUrl?: string; ownerAddress?: string; circuitsProfileUrl: string },
): Promise<ClawdHqConnectResult> {
  const existing = await prisma.clawdHqLink.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (existing && existing.status === WalletStatus.ACTIVE) {
    return { handle: existing.handle, walletLinked: existing.walletLinked, announcementPosted: true };
  }

  const handle = await findAvailableHandle(params.name);
  const avatarUrl = params.avatarUrl || fallbackAvatarUrl(params.name);

  let registration;
  try {
    registration = await registerClawdHqAgent({ name: params.name, handle, description: params.description, avatarUrl, ownerAddress: params.ownerAddress });
  } catch (err) {
    if (err instanceof ClawdHqHandleTakenError) {
      // Lost a race against a concurrent registration for the same handle — retry once with a
      // freshly-checked handle rather than surfacing a collision the caller can't do anything about.
      const retryHandle = await findAvailableHandle(`${params.name}_${Math.random().toString(36).slice(2, 6)}`);
      registration = await registerClawdHqAgent({ name: params.name, handle: retryHandle, description: params.description, avatarUrl, ownerAddress: params.ownerAddress });
    } else {
      throw err;
    }
  }

  const encryptedApiKey = await encryptApiKey(registration.apiKey);
  await prisma.clawdHqLink.upsert({
    where: { chain_agentChainId: { chain, agentChainId } },
    create: { chain, agentChainId, clawdhqAgentId: registration.clawdhqAgentId, handle, encryptedApiKey, walletLinked: false, status: WalletStatus.ACTIVE },
    update: { clawdhqAgentId: registration.clawdhqAgentId, handle, encryptedApiKey, walletLinked: false, status: WalletStatus.ACTIVE },
  });

  let walletLinked = false;
  try {
    const walletAddress = await getAgentWalletAddress(chain, agentChainId);
    if (walletAddress) {
      await linkClawdHqWallet(registration.apiKey, walletAddress);
      walletLinked = true;
      await prisma.clawdHqLink.update({ where: { chain_agentChainId: { chain, agentChainId } }, data: { walletLinked: true } });
    }
    // No wallet yet (auto-provisioning is async, see AgentWalletFundingPrompt) — not an error,
    // ClawdHQ's own API explicitly supports attaching a wallet later via the same endpoint;
    // walletLinked just stays false until something calls retryClawdHqWalletLink below.
  } catch (err) {
    console.error(`[clawdhqLinkCustody] wallet link failed for ${chain}:${agentChainId}:`, err instanceof Error ? err.message : err);
  }

  let announcementPosted = false;
  try {
    // Links back to this agent's Circuits Protocol page, not its own ClawdHQ profile — a
    // self-link on a post already sitting on that same profile is dead weight; the point of
    // the link is to send ClawdHQ readers to where the agent actually operates.
    await postToClawdHq(registration.apiKey, `👋 I'm ${params.name}, a new autonomous agent now live on Circuits Protocol. See my on-chain operations: ${params.circuitsProfileUrl}`);
    announcementPosted = true;
  } catch (err) {
    console.error(`[clawdhqLinkCustody] announcement post failed for ${chain}:${agentChainId}:`, err instanceof Error ? err.message : err);
  }

  return { handle, walletLinked, announcementPosted };
}

/** Attempts the wallet link again for an agent that connected before its AgentWallet address
 * was available. Safe to call repeatedly — a no-op once walletLinked is already true or there's
 * no link at all. */
export async function retryClawdHqWalletLink(chain: Chain, agentChainId: string): Promise<boolean> {
  const link = await prisma.clawdHqLink.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!link || link.status !== WalletStatus.ACTIVE || link.walletLinked) return link?.walletLinked ?? false;

  const walletAddress = await getAgentWalletAddress(chain, agentChainId);
  if (!walletAddress) return false;

  const apiKey = await decryptApiKey(link.encryptedApiKey);
  await linkClawdHqWallet(apiKey, walletAddress);
  await prisma.clawdHqLink.update({ where: { chain_agentChainId: { chain, agentChainId } }, data: { walletLinked: true } });
  return true;
}

/** Public-safe connection status — never returns the decrypted API key. */
export async function getClawdHqLinkStatus(chain: Chain, agentChainId: string): Promise<{ handle: string; walletLinked: boolean; profileUrl: string } | null> {
  const link = await prisma.clawdHqLink.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!link || link.status !== WalletStatus.ACTIVE) return null;
  return { handle: link.handle, walletLinked: link.walletLinked, profileUrl: clawdHqProfileUrl(link.handle) };
}

/** Posts an activity update as this agent on ClawdHQ — the ongoing counterpart to
 * connectAgentToClawdHq's one-time introductory post, called by apps/indexer's EVM listener
 * whenever a job completes, a launch graduates, a listing sells, or a dispute resolves (see
 * evm.ts's processBatch). Silently a no-op for an agent that was never connected (most callers
 * shouldn't need to check first — this *is* the check), and never throws: same "a downstream
 * integration hiccup can't be allowed to break the indexer's main sync loop" reasoning as every
 * other best-effort step in this file. */
export async function postAgentActivityToClawdHq(chain: Chain, agentChainId: string, message: string): Promise<void> {
  try {
    const link = await prisma.clawdHqLink.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
    if (!link || link.status !== WalletStatus.ACTIVE) return;
    const apiKey = await decryptApiKey(link.encryptedApiKey);
    await postToClawdHq(apiKey, message);
  } catch (err) {
    console.error(`[clawdhqLinkCustody] activity post failed for ${chain}:${agentChainId}:`, err instanceof Error ? err.message : err);
  }
}

/** Same name-lookup-then-post shape as apps/indexer's own postClawdHqActivity helper —
 * duplicated rather than shared, since that one reuses a publicClient the indexer's polling loop
 * already has open, while every caller here (agentSpendActions.ts, agentSkillActions.ts,
 * knowledgeResolveClient.ts, and apps/web's a2a/knowledge-resolve routes) is a one-off request
 * handler with no publicClient of its own. EVM-only, matching every one of those callers' own
 * scope — constructs a fresh read-only client per call rather than threading one through, since
 * none of these call sites run often enough for that to matter. Never throws: same best-effort
 * discipline as postAgentActivityToClawdHq itself, which this wraps. Used for both a spend
 * (agent as payer) and an earning (agent as payee, e.g. a paid x402 reply or knowledge resolve)
 * — the name/profile-url lookup is identical either way, only the message text differs per
 * caller. */
export async function postAgentChainActivityToClawdHq(chain: EvmPrismaChain, agentChainId: string, message: (name: string, profileUrl: string) => string): Promise<void> {
  try {
    const publicClient = createPublicClient({ chain: viemChainFor(chain), transport: rpcTransportFor(chain) });
    const card = (await publicClient.readContract({
      address: contractAddressFor(chain),
      abi: clawdHQCoreAbi,
      functionName: "agents",
      args: [BigInt(agentChainId)],
    })) as readonly [bigint, `0x${string}`, string, ...unknown[]];
    const name = card[2];
    if (!name) return;
    const profileUrl = circuitsAgentProfileUrl(name, agentChainId);
    await postAgentActivityToClawdHq(chain as unknown as Chain, agentChainId, message(name, profileUrl));
  } catch (err) {
    console.error(`[clawdhqLinkCustody] on-chain activity post failed for ${chain}:${agentChainId}:`, err instanceof Error ? err.message : err);
  }
}
