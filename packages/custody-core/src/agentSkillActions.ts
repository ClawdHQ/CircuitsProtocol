import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SpendAction, type Chain } from "@clawdhq/custody-db";
import { executeAgentSpend } from "./agentSpendPolicy.js";
import { fetchGuarded } from "./guardedFetch.js";
import { resolveSkillInvocation, type SkillInvocation } from "./skillRegistry.js";

export interface SkillCallResult {
  result: unknown;
  txHashOrRef: string;
}

export interface SkillToolDescriptor {
  toolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const CLAWDHQ_AGENT_TOOL_NAME = "ask_agent";
const CLAWDHQ_AGENT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chain: { type: "string", description: "The chain slug the target agent is registered on, e.g. base-sepolia." },
    agentChainId: { type: "string", description: "The target agent's on-chain numeric id." },
    message: { type: "string", description: "The question or message to send to the target agent." },
  },
  required: ["chain", "agentChainId", "message"],
};

/** Connects fresh per call (stateless, mirroring how apps/web's own .../mcp route builds a
 * fresh McpServer per request on the *server* side of this same protocol) — no long-running MCP
 * session to keep alive between calls here. */
async function withMcpClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "clawdhq-hosted-agent-runtime", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callMcpTool(url: string, toolName: string | undefined, input: unknown): Promise<unknown> {
  return withMcpClient(url, async (client) => {
    const { tools } = await client.listTools();
    const tool = toolName ? tools.find((t) => t.name === toolName) : tools[0];
    if (!tool) throw new Error(`MCP server at ${url} exposes no matching tool${toolName ? ` named "${toolName}"` : ""}.`);
    return client.callTool({ name: tool.name, arguments: input as Record<string, unknown> | undefined });
  });
}

/** Substitutes `{paramName}` placeholders in an http-kind invocation's `endpoint` from the
 * matching key in `input`, tracking which keys were consumed so the caller can route the rest to
 * a GET query string or POST body instead — see this function's caller for why a real API like
 * GoPlus's `token_security/{chainId}` needs both a path param and separate query params in the
 * same call. Throws on a placeholder with no matching input key rather than silently substituting
 * "undefined" into a URL. */
function substitutePathParams(endpoint: string, input: Record<string, unknown>): { url: string; consumed: Set<string> } {
  const consumed = new Set<string>();
  const url = endpoint.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (input[key] === undefined) throw new Error(`Skill call is missing required path parameter "${key}".`);
    consumed.add(key);
    return encodeURIComponent(String(input[key]));
  });
  return { url, consumed };
}

/** Every `input` key not already consumed as a path param becomes a GET query-string param,
 * appended onto `url` with the right separator whether or not `url` already has its own literal
 * `?query=param` baked in (a publisher-supplied endpoint like
 * `.../forecast?current=temperature_2m` is a real, legitimate shape — not just the templated
 * `{param}` kind). */
function appendQueryString(url: string, input: Record<string, unknown>, consumed: Set<string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (consumed.has(key) || value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

/** Exported (alongside listSkillTools/callAgentSkill) so an owner-facing "dry run this skill"
 * path or ad-hoc verification can exercise the real request-building/dispatch logic directly,
 * without also invoking callAgentSkill's spend-gate/DB pipeline for a priced skill. */
export async function invokeSkill(invocation: SkillInvocation, input: unknown, toolName?: string): Promise<unknown> {
  switch (invocation.kind) {
    case "http": {
      const params = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const { url, consumed } = substitutePathParams(invocation.endpoint, params);

      if (invocation.method === "GET") {
        const { data } = await fetchGuarded(appendQueryString(url, params, consumed), { method: "GET", headers: invocation.headers, timeoutMs: 20_000 });
        return data;
      }

      const body = Object.fromEntries(Object.entries(params).filter(([key]) => !consumed.has(key)));
      const { data } = await fetchGuarded(url, { method: "POST", body, headers: invocation.headers, timeoutMs: 20_000 });
      return data;
    }
    case "mcp": {
      return callMcpTool(invocation.url, toolName, input);
    }
    case "clawdhq-agent": {
      const parsed = input as { chain?: string; agentChainId?: string; message?: string } | undefined;
      if (!parsed?.chain || !parsed?.agentChainId || !parsed?.message) {
        throw new Error('The "clawdhq-agent" skill requires input shaped { chain, agentChainId, message }.');
      }
      const baseUrl = process.env.HOSTED_RUNTIME_APP_BASE_URL;
      if (!baseUrl) {
        throw new Error("HOSTED_RUNTIME_APP_BASE_URL isn't configured — required to reach another agent's MCP server.");
      }
      const url = `${baseUrl.replace(/\/$/, "")}/api/agents/hosted/${parsed.chain}/${parsed.agentChainId}/mcp`;
      return callMcpTool(url, CLAWDHQ_AGENT_TOOL_NAME, { message: parsed.message });
    }
  }
}

/** Lists the individual tool(s) an already-resolved invocation actually exposes, for building an
 * LLM tool menu — separate from invoking one, and never spend-gated (listing isn't itself an
 * action). "http"-kind entries always expose exactly the one call the registry describes; "mcp"/
 * "clawdhq-agent"-kind entries are asked live via listTools(), since MCP servers are
 * self-describing and a fixed single-tool assumption would be wrong for a multi-tool server —
 * see llmClient.ts's reactive tool-calling, the one caller that needs a real per-tool schema
 * rather than just "is this skill available."
 *
 * Takes the invocation directly (rather than resolving skillId itself, the way this function
 * used to) so a caller that already resolved it — e.g. hosted-agent-runtime's
 * loadResolvedAgentSkills, which merges custody-core's static SKILL_INVOCATIONS with social-db's
 * user-published PublishedSkill table — doesn't need this package to know about social-db just
 * to re-derive something it already has. See listSkillTools below for the skillId-only,
 * static-registry-only convenience wrapper most callers still want. */
export async function listResolvedSkillTools(skillId: string, invocation: SkillInvocation): Promise<SkillToolDescriptor[]> {
  switch (invocation.kind) {
    case "http":
      return [{ toolName: skillId, inputSchema: invocation.inputSchema }];
    case "mcp": {
      const { tools } = await withMcpClient(invocation.url, (client) => client.listTools());
      return tools.map((t) => ({ toolName: t.name, description: t.description, inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" } }));
    }
    case "clawdhq-agent":
      return [{ toolName: CLAWDHQ_AGENT_TOOL_NAME, description: "Ask another ClawdHQ agent a question via its own MCP server.", inputSchema: CLAWDHQ_AGENT_INPUT_SCHEMA }];
  }
}

/** Resolves skillId against custody-core's own static SKILL_INVOCATIONS registry only (built-in
 * + operator-configured skills) and lists its tools — returns `[]` for anything that registry
 * can't resolve, including a valid PublishedSkill id, since this package has no social-db
 * dependency to check that table itself. Kept for callers that only ever deal in built-in
 * skillIds (the owner-facing manual-test route); anything that also needs to resolve
 * user-published skills should resolve its own invocation (checking PublishedSkill when the
 * static registry misses) and call listResolvedSkillTools above directly instead. Returns `[]`
 * for an unresolvable skillId rather than throwing, since callers iterate a set of
 * already-resolved skills where this should always succeed; a resolution race (registry reloaded
 * mid-request) degrades to "no tools," not a crash. */
export async function listSkillTools(skillId: string): Promise<SkillToolDescriptor[]> {
  const invocation = resolveSkillInvocation(skillId);
  if (!invocation) return [];
  return listResolvedSkillTools(skillId, invocation);
}

/** Invokes an already-resolved skill invocation on an agent's behalf — the general-purpose
 * sibling to postJobFromAgentWallet/payFromAgentWallet (agentSpendActions.ts), gated through the
 * identical executeAgentSpend pipeline whenever the resolved invocation has a nonzero priceUsdc:
 * same PENDING-before-execute audit trail, same daily-cap/allowed-actions gate as every other
 * spend action, via SpendAction.CALL_SKILL. Free (priceUsdc "0") skills — including the one
 * hardcoded `clawdhq-agent` entry, and any free PublishedSkill — skip the spend gate entirely and
 * just execute, same as every other free action in this codebase.
 *
 * Takes `invocation` directly rather than resolving skillId itself — see listResolvedSkillTools's
 * doc comment for why (the same social-db-dependency reasoning applies here). `skillId` is still
 * needed as a label for the spend log's targetRef/txHashOrRef, not for resolution.
 *
 * `toolName` selects which of a possibly-multi-tool mcp-kind skill's tools to call — sourced
 * from `listResolvedSkillTools` above; ignored for "http"/"clawdhq-agent" kinds, which each
 * expose exactly one.
 *
 * No on-chain payout to a third-party skill's publisher happens here — priceUsdc is a
 * spend-policy-gated control/metering cost recorded to AgentSpendLog, not yet a settled
 * payment to anyone external. Real payout needs a payoutAddress per registry entry and its own
 * settlement design; out of scope for now. */
export async function callResolvedAgentSkill(chain: Chain, agentChainId: string, skillId: string, invocation: SkillInvocation, input: unknown, toolName?: string): Promise<SkillCallResult> {
  let capturedResult: unknown;

  if (Number(invocation.priceUsdc) > 0) {
    const spend = await executeAgentSpend(chain, agentChainId, SpendAction.CALL_SKILL, invocation.priceUsdc, async () => {
      capturedResult = await invokeSkill(invocation, input, toolName);
      return { txHashOrRef: `skill:${skillId}:${Date.now()}`, targetRef: skillId };
    });
    return { result: capturedResult, txHashOrRef: spend.txHashOrRef };
  }

  capturedResult = await invokeSkill(invocation, input, toolName);
  return { result: capturedResult, txHashOrRef: `skill:${skillId}:${Date.now()}` };
}

/** Resolves skillId against custody-core's own static SKILL_INVOCATIONS registry only — see
 * listSkillTools's doc comment for the same caveat (won't resolve a PublishedSkill id). Throws
 * rather than silently no-opping: callers (llmClient.ts's reactive tool-calling, tick.ts's
 * USE_SKILL branch) only ever offer the model skills that already resolved via
 * loadResolvedAgentSkills — using their own already-resolved invocation via
 * callResolvedAgentSkill above, not this function — so reaching here with an unresolvable
 * skillId is a bug, not a normal "not available" outcome. Kept for the owner-facing manual-test
 * route and any other caller that only ever deals in built-in skillIds. */
export async function callAgentSkill(chain: Chain, agentChainId: string, skillId: string, input: unknown, toolName?: string): Promise<SkillCallResult> {
  const invocation = resolveSkillInvocation(skillId);
  if (!invocation) throw new Error(`No invocation is registered for skill "${skillId}".`);
  return callResolvedAgentSkill(chain, agentChainId, skillId, invocation, input, toolName);
}
