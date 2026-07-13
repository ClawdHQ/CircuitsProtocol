import { prisma, CommunicationStyle, SkillEndpointKind, SkillHttpMethod, KnowledgeContributionType, type Chain, type PublishedSkill } from "@clawdhq/social-db";
import { resolveSkillInvocation, type SkillInvocation } from "@clawdhq/custody-core";
import { BUILTIN_SKILLS } from "@clawdhq/custody-core/skill-catalog";
import type { AgentPersonaContext } from "./llmClient.js";

interface PublishedSkillParam {
  name: string;
  description: string;
  required: boolean;
}

/** Mirrors custody-core's SKILL_INVOCATIONS entries' inputSchema shape exactly, so a
 * PublishedSkill resolves into the same SkillInvocation shape a built-in skill does and every
 * downstream consumer (callResolvedAgentSkill, buildSkillTools) needs no PublishedSkill-specific
 * branch of its own. */
function buildInputSchemaFromParams(params: PublishedSkillParam[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: "string", description: p.description }])),
    required: params.filter((p) => p.required).map((p) => p.name),
  };
}

/** Converts a DB row (apps/web's publish route already live-verified its endpoint before this
 * row could exist — see PublishedSkill's own schema doc comment) into the same SkillInvocation
 * union custody-core's static registry resolves to, so it flows through callResolvedAgentSkill's
 * identical spend-gate/audit pipeline. Returns null for a reference-only listing (no endpoint
 * supplied at publish time) — same "nothing to call" outcome resolveSkillInvocation returns for
 * most of BUILTIN_SKILLS. Deliberately no `headers` — see the schema's own doc comment for why a
 * published skill can't carry auth. */
export function publishedSkillToInvocation(skill: PublishedSkill): SkillInvocation | null {
  if (!skill.endpointUrl || !skill.endpointKind) return null;

  if (skill.endpointKind === SkillEndpointKind.MCP) {
    return { kind: "mcp", url: skill.endpointUrl, priceUsdc: skill.priceUsdc };
  }

  const params = (skill.paramsJson as unknown as PublishedSkillParam[] | null) ?? [];
  return {
    kind: "http",
    endpoint: skill.endpointUrl,
    method: skill.httpMethod === SkillHttpMethod.POST ? "POST" : "GET",
    priceUsdc: skill.priceUsdc,
    inputSchema: buildInputSchemaFromParams(params),
  };
}

const COMMUNICATION_STYLE_TO_CLIENT: Record<CommunicationStyle, AgentPersonaContext["communicationStyle"]> = {
  FORMAL: "formal",
  CASUAL: "casual",
  TECHNICAL: "technical",
  FRIENDLY: "friendly",
};

const ACQUIRED_KNOWLEDGE_CONTEXT_LIMIT = 3;

/** The most recent knowledge acquisitions (AgentAcquiredKnowledge, written by
 * knowledgeAcquisition.ts's acquireKnowledge after a successful USE_KNOWLEDGE) that should shape
 * this agent's behavior going forward — a Prompt's text, a Dataset's sample, or a Model's output,
 * all already reduced to plain text at acquisition time. Bounded to the most recent few, not
 * "everything ever acquired": this feeds directly into every future system prompt (see
 * llmClient.ts's buildSystemPrompt), so unbounded growth here means unbounded prompt growth. */
async function loadAcquiredKnowledge(chain: Chain, agentChainId: string): Promise<AgentPersonaContext["acquiredKnowledge"]> {
  const rows = await prisma.agentAcquiredKnowledge.findMany({
    where: { chain, agentChainId },
    orderBy: { acquiredAt: "desc" },
    take: ACQUIRED_KNOWLEDGE_CONTEXT_LIMIT,
    select: { contributionTitle: true, content: true },
  });
  return rows.map((r) => ({ title: r.contributionTitle, content: r.content }));
}

/** Loads an agent's persona (social-db's CognitiveLayer), standing goal (AgentGoal), and recently
 * acquired knowledge (AgentAcquiredKnowledge) and maps them into the shape llmClient.ts's
 * system-prompt builder expects — shared by the reactive .../a2a proxy route (apps/web) and the
 * scheduled tick (tick.ts) so this query and its uppercase-enum-to-lowercase-literal translation
 * exists once, not twice. Acquired knowledge folds in here (rather than as a separate parameter
 * threaded through generateAgentReply/decideAgentAction) so every future call — reactive or
 * proactive — automatically benefits from a past USE_KNOWLEDGE acquisition, not just the one
 * that triggered it. Defaults to a bare "technical, no persona" context rather than throwing when
 * nothing's been configured yet — a hosted agent should still be able to answer before its owner
 * fills out a persona. */
export async function loadAgentPersonaContext(chain: Chain, agentChainId: string): Promise<AgentPersonaContext> {
  const [layer, goal, acquiredKnowledge] = await Promise.all([
    prisma.cognitiveLayer.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } }),
    prisma.agentGoal.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } }),
    loadAcquiredKnowledge(chain, agentChainId),
  ]);

  return {
    displayName: layer?.displayName ?? "",
    worldview: layer?.worldview ?? "",
    voicePersona: layer?.voicePersona ?? "",
    customSystemPrompt: layer?.customSystemPrompt ?? "",
    communicationStyle: layer ? COMMUNICATION_STYLE_TO_CLIENT[layer.communicationStyle] : "technical",
    personality: layer?.personality ?? [],
    knowledgeDomains: layer?.knowledgeDomains ?? [],
    goal: goal?.goal ?? null,
    foundationModel: layer?.foundationModel ?? "claude-haiku-4.5",
    acquiredKnowledge,
  };
}

export interface ResolvedSkill {
  skillId: string;
  name: string;
  description: string;
  invocation: SkillInvocation;
}

/** Loads an agent's installed skills (social-db's AgentSkill) and resolves each — first against
 * custody-core's static SKILL_INVOCATIONS registry (built-in + operator-configured skills), then
 * against social-db's PublishedSkill table for anything the static registry doesn't recognize —
 * returning only the subset that's actually callable. An installed skill that resolves nowhere
 * is a declared capability with nothing to expose as a tool (most of BUILTIN_SKILLS: a GitHub
 * repo, an npm package, a docs page, not a live endpoint; or a PublishedSkill someone installed
 * before its publisher later deleted it), so it's silently excluded here rather than surfaced as
 * a broken one. Shared by llmClient.ts's reactive tool-calling and tick.ts's USE_SKILL action,
 * same reasoning loadAgentPersonaContext documents for sharing that query once instead of twice.
 *
 * This is the one place both resolution sources merge — callers downstream (buildSkillTools,
 * tick.ts's handleAction) work off the resulting ResolvedSkill.invocation directly via
 * listResolvedSkillTools/callResolvedAgentSkill rather than re-resolving by skillId, since
 * custody-core has no social-db dependency to check PublishedSkill itself. */
export async function loadResolvedAgentSkills(chain: Chain, agentChainId: string): Promise<ResolvedSkill[]> {
  const installed = await prisma.agentSkill.findMany({ where: { chain, agentChainId } });
  const resolved: ResolvedSkill[] = [];
  const unresolvedSkillIds: string[] = [];

  for (const { skillId } of installed) {
    const invocation = resolveSkillInvocation(skillId);
    if (!invocation) {
      unresolvedSkillIds.push(skillId);
      continue;
    }
    const catalogEntry = BUILTIN_SKILLS.find((s) => s.id === skillId);
    resolved.push({ skillId, name: catalogEntry?.name ?? skillId, description: catalogEntry?.desc ?? "", invocation });
  }

  if (unresolvedSkillIds.length > 0) {
    const published = await prisma.publishedSkill.findMany({ where: { id: { in: unresolvedSkillIds } } });
    for (const skill of published) {
      const invocation = publishedSkillToInvocation(skill);
      if (!invocation) continue;
      resolved.push({ skillId: skill.id, name: skill.name, description: skill.desc, invocation });
    }
  }

  return resolved;
}

export interface KnowledgeCandidate {
  id: string;
  type: KnowledgeContributionType;
  title: string;
  description: string;
  tags: string[];
  priceUsdc: string;
}

const KNOWLEDGE_CANDIDATE_LIMIT = 5;
const KNOWLEDGE_SCAN_LIMIT = 50;

/** Loads a shortlist of published KnowledgeContribution rows for the tick's USE_KNOWLEDGE action
 * — a direct social-db query, not an HTTP call to apps/web's own /api/knowledge/contributions:
 * this package also runs inside apps/indexer's standalone scheduler process, which talks to these
 * DB packages directly the same way tick.ts's other DB reads already do. Metadata only
 * (id/title/description/tags/price) — contentUrl/contentBody are never selected here, the same
 * "content is only ever behind a paid call" rule knowledgeContributions.ts's serializer enforces
 * on the apps/web side; the actual content only ever comes back through
 * resolveKnowledgeContribution's paid .../resolve round-trip.
 *
 * Ranks by simple keyword overlap between the agent's knowledgeDomains/goal and each
 * contribution's title/description/tags — real semantic search over @clawdhq/clawmem (currently
 * unused by this package) is a natural follow-up, not a blocker for a first version: an agent
 * with no goal/domains configured still gets *a* shortlist (the most recent published listings),
 * just an unranked one. */
export async function loadKnowledgeCandidates(persona: AgentPersonaContext): Promise<KnowledgeCandidate[]> {
  const keywords = [...persona.knowledgeDomains, ...(persona.goal ? persona.goal.split(/\s+/) : [])]
    .map((w) => w.toLowerCase().trim())
    .filter((w) => w.length > 2);

  const published = await prisma.knowledgeContribution.findMany({
    where: { isPublished: true },
    select: { id: true, type: true, title: true, description: true, tags: true, priceUsdc: true },
    orderBy: { createdAt: "desc" },
    take: KNOWLEDGE_SCAN_LIMIT,
  });

  if (keywords.length === 0) return published.slice(0, KNOWLEDGE_CANDIDATE_LIMIT);

  const ranked = published
    .map((c) => ({ c, score: keywords.reduce((sum, kw) => sum + (`${c.title} ${c.description} ${c.tags.join(" ")}`.toLowerCase().includes(kw) ? 1 : 0), 0) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ c }) => c);

  return (ranked.length > 0 ? ranked : published).slice(0, KNOWLEDGE_CANDIDATE_LIMIT);
}
