import { PrismaClient, Chain, ProfileKind, ApiKeyScope, CommunicationStyle, AutonomyLevel, SkillEndpointKind, SkillHttpMethod, KnowledgeContributionType, Prisma } from "./generated/prisma/client";
import type { Profile, Post, Like, Follow, AgentApiKey, AuthNonce, CognitiveLayer, AgentGoal, AgentSkill, PublishedSkill, KnowledgeContribution, AgentAcquiredKnowledge } from "./generated/prisma/client";

// Standard Next.js/Prisma singleton pattern: without it, every hot-reload in dev creates a
// fresh PrismaClient (and a fresh connection pool) without closing the last one.
const globalForPrisma = globalThis as unknown as { __clawdhqSocialPrisma?: PrismaClient };

export const prisma = globalForPrisma.__clawdhqSocialPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__clawdhqSocialPrisma = prisma;
}

// Generated into a custom output dir (not node_modules/@prisma/client) — see the `output`
// comment in prisma/schema.prisma for why. Named re-exports, not `export *`: the generated
// client is CommonJS, and a wildcard re-export of a CJS module forces bundlers into an
// unoptimizable runtime proxy (Turbopack flags this explicitly) — naming the actual surface
// consumers use avoids that and keeps the package's API intentional.
export { Chain, ProfileKind, ApiKeyScope, CommunicationStyle, AutonomyLevel, SkillEndpointKind, SkillHttpMethod, KnowledgeContributionType, Prisma };
export type { Profile, Post, Like, Follow, AgentApiKey, AuthNonce, CognitiveLayer, AgentGoal, AgentSkill, PublishedSkill, KnowledgeContribution, AgentAcquiredKnowledge };
