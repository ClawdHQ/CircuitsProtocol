import { prisma, KnowledgeContributionType, type Chain } from "@clawdhq/social-db";
import { resolveKnowledgeContribution, fetchGuarded } from "@clawdhq/custody-core";
import type { KnowledgeCandidate } from "./persona.js";

// What actually happens when a hosted agent's tick pays for a knowledge contribution — the
// "then what" that resolveKnowledgeContribution (custody-core, payment only) deliberately
// doesn't answer, since that function is a portable payment primitive with no notion of agent
// behavior. Reduces any of the three contribution types down to the same shape (bounded plain
// text) and persists it as one AgentAcquiredKnowledge row (social-db), which
// loadAgentPersonaContext (persona.ts) then splices into every future system prompt.

const ACQUIRED_CONTENT_MAX_CHARS = 4000;
const DATASET_FETCH_TIMEOUT_MS = 15_000;
const MODEL_CALL_TIMEOUT_MS = 20_000;

function truncate(text: string): string {
  return text.length > ACQUIRED_CONTENT_MAX_CHARS ? `${text.slice(0, ACQUIRED_CONTENT_MAX_CHARS)}…` : text;
}

/** Fetches a DATASET contribution's contentUrl and reduces it to a bounded text sample —
 * expectJson:false since a real dataset is routinely CSV/plain text, not JSON (see
 * guardedFetch.ts's own doc comment on why that option exists). This is a sample for an LLM to
 * read, not a data-processing pipeline: no format-aware parsing (CSV columns, JSON structure),
 * just bytes-to-text truncated to a size a prompt can hold. */
async function sampleDataset(contentUrl: string): Promise<string> {
  const { data } = await fetchGuarded(contentUrl, { method: "GET", expectJson: false, timeoutMs: DATASET_FETCH_TIMEOUT_MS });
  return truncate(String(data ?? ""));
}

/** Calls a MODEL contribution's contentUrl as an inference endpoint — a fixed POST-JSON-in/
 * JSON-out contract (no per-model schema, unlike PublishedSkill's optional paramsJson), mirroring
 * agentSkillActions.ts's invokeSkill POST-kind convention: the parsed input is sent directly as
 * the request body, not wrapped in an envelope. `knowledgeInput` comes from the LLM's own
 * AgentAction (decideAgentAction's structured output) — malformed JSON is the model's own mistake,
 * surfaced as a rejection like every other malformed-LLM-output case in tick.ts, not swallowed. */
async function callModel(contentUrl: string, knowledgeInput: string | undefined): Promise<string> {
  let input: unknown = {};
  if (knowledgeInput) {
    try {
      input = JSON.parse(knowledgeInput);
    } catch {
      throw new Error("knowledgeInput wasn't valid JSON.");
    }
  }
  const { data } = await fetchGuarded(contentUrl, { method: "POST", body: input, timeoutMs: MODEL_CALL_TIMEOUT_MS });
  return truncate(typeof data === "string" ? data : JSON.stringify(data));
}

/** Pays for (via resolveKnowledgeContribution) and acquires one knowledge contribution's content,
 * then persists it so it shapes this agent's behavior going forward — not just a one-tick report
 * that it happened. Called from tick.ts's USE_KNOWLEDGE branch; kept in this package (not
 * custody-core) since "what does an agent do with acquired content" is agent-behavior policy, the
 * same reasoning persona.ts/llmClient.ts already live here rather than in the portable payment
 * package. */
export async function acquireKnowledge(chain: Chain, agentChainId: string, candidate: KnowledgeCandidate, knowledgeInput: string | undefined): Promise<{ summary: string }> {
  const { contentUrl, contentBody } = await resolveKnowledgeContribution(chain, agentChainId, candidate.id);

  let content: string;
  switch (candidate.type) {
    case KnowledgeContributionType.PROMPT:
    case KnowledgeContributionType.MEMORY:
      content = truncate(contentBody ?? "");
      break;
    case KnowledgeContributionType.DATASET:
      if (!contentUrl) throw new Error("Resolved DATASET contribution has no contentUrl.");
      content = await sampleDataset(contentUrl);
      break;
    case KnowledgeContributionType.MODEL:
      if (!contentUrl) throw new Error("Resolved MODEL contribution has no contentUrl.");
      content = await callModel(contentUrl, knowledgeInput);
      break;
  }

  await prisma.agentAcquiredKnowledge.create({
    data: { chain, agentChainId, contributionId: candidate.id, contributionTitle: candidate.title, contributionType: candidate.type, content },
  });

  return { summary: `acquired knowledge from "${candidate.title}" (${candidate.type}, ${content.length} chars) — will shape future replies and ticks` };
}
