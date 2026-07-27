/** Thin HTTP client for ClawdHQ (https://clawdhq.xyz) — a genuinely separate AI-agent social
 * platform, deployed independently of Circuits Protocol with its own database and its own Circle
 * developer account. There is no shared backend and no shared Circle credentials between the two
 * — confirmed against ClawdHQ's own live deployment before writing this: it has its own
 * AGENT_REGISTRY_ADDRESS, its own CIRCLE_API_KEY/CIRCLE_TREASURY_WALLET, its own Postgres.
 *
 * "Wallet unification" instead works because both platforms operate on Arc Testnet and ClawdHQ's
 * own Agent model natively supports an externally-owned payout wallet (`walletType: 'EXTERNAL'`,
 * set via POST /agents/wallet) — pointing it at the same on-chain address Circuits Protocol
 * already custodies means both platforms read the identical real balance directly from the
 * chain, with no custom sync code and nothing that can drift out of sync.
 *
 * Every function here is a pure fetch wrapper — no Prisma, no encryption, safe to import from
 * anywhere. See clawdhqLinkCustody.ts for the encrypted-storage layer built on top of this. */

function apiBaseUrl(): string {
  return process.env.CLAWDHQ_API_BASE_URL || "https://api.clawdhq.xyz";
}

export interface ClawdHqRegisterResult {
  clawdhqAgentId: string;
  apiKey: string;
  claimUrl: string;
}

/** POST /agents/register. Handle must already be confirmed available by the caller (see
 * clawdhqLinkCustody.ts's handle-dedup loop) — ClawdHQ itself only reports the collision via a
 * 409 after the fact, it doesn't offer a separate availability-check endpoint. */
export async function registerClawdHqAgent(params: {
  name: string;
  handle: string;
  description?: string;
  avatarUrl?: string;
  ownerAddress?: string;
}): Promise<ClawdHqRegisterResult> {
  const res = await fetch(`${apiBaseUrl()}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: params.name,
      handle: params.handle,
      description: params.description,
      avatar_url: params.avatarUrl,
      owner_address: params.ownerAddress,
    }),
  });
  const body = (await res.json().catch(() => null)) as { error?: string; agent?: { id: string; api_key: string; claim_url: string } } | null;
  if (!res.ok || !body?.agent) {
    if (res.status === 409) throw new ClawdHqHandleTakenError(params.handle);
    throw new Error(`ClawdHQ registration failed (${res.status}): ${body?.error ?? "unknown error"}`);
  }
  return { clawdhqAgentId: body.agent.id, apiKey: body.agent.api_key, claimUrl: body.agent.claim_url };
}

export class ClawdHqHandleTakenError extends Error {
  constructor(public readonly handle: string) {
    super(`ClawdHQ handle "${handle}" is already taken`);
  }
}

/** True if `handle` is free on ClawdHQ right now — best-effort pre-check via the public
 * GET /agents/:handle (404 = free), used to avoid burning obviously-taken handles before
 * attempting a real registration. Not atomic with registerClawdHqAgent (nothing stops a
 * concurrent registration between the check and the real call), which is exactly why
 * registerClawdHqAgent also handles the 409 itself rather than trusting this alone. */
export async function isClawdHqHandleAvailable(handle: string): Promise<boolean> {
  const res = await fetch(`${apiBaseUrl()}/agents/${encodeURIComponent(handle)}`);
  return res.status === 404;
}

/** POST /agents/wallet — attaches an externally-owned payout address (walletType: 'EXTERNAL')
 * to an already-registered ClawdHQ agent. Auth: that agent's own ClawdHQ API key. */
export async function linkClawdHqWallet(apiKey: string, walletAddress: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/agents/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ wallet_address: walletAddress }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`ClawdHQ wallet link failed (${res.status}): ${body?.error ?? "unknown error"}`);
  }
}

/** POST /posts — publishes as the authenticated agent. Used for the one-time "I'm live"
 * announcement post at connect time (see clawdhqLinkCustody.ts) — ClawdHQ's API has no
 * profile-update endpoint, so this is deliberately a one-shot announcement, not ongoing sync. */
export async function postToClawdHq(apiKey: string, content: string): Promise<{ postId: string }> {
  const res = await fetch(`${apiBaseUrl()}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ content }),
  });
  const body = (await res.json().catch(() => null)) as { error?: string; data?: { id: string } } | null;
  if (!res.ok || !body?.data) throw new Error(`ClawdHQ post failed (${res.status}): ${body?.error ?? "unknown error"}`);
  return { postId: body.data.id };
}

/** Public profile URL for a ClawdHQ handle — used wherever the UI links out to an agent's
 * ClawdHQ page (its own domain, not the api. subdomain this client otherwise talks to). */
export function clawdHqProfileUrl(handle: string): string {
  return `https://www.clawdhq.xyz/${encodeURIComponent(handle)}`;
}

// Same slugify formula as apps/web/src/lib/agentSlug.ts's agentUrlId — duplicated rather than
// imported (apps/indexer and this package can't depend on apps/web), same "small pure formula,
// simpler to keep in sync by hand than to route through an extra parameter at every call site"
// reasoning as fallbackAvatarUrl in clawdhqLinkCustody.ts. Keep these two in sync if either changes.
function slugifyAgentName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** This agent's own Circuits Protocol page — used as the "link to the circuits operation" in
 * every ClawdHQ activity post (see postAgentActivityToClawdHq), since every one of those posts
 * concerns something that happened to a specific agent. Arc-only, matching Circuits Protocol's
 * current UI scope (see lib/chains.ts's SELECTABLE_CHAINS). */
export function circuitsAgentProfileUrl(name: string, agentChainId: string): string {
  const slug = slugifyAgentName(name);
  const urlId = slug ? `${slug}-${agentChainId}` : agentChainId;
  return `https://app.circuitsprotocol.com/agents/${urlId}`;
}
