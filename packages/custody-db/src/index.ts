import {
  PrismaClient,
  Chain,
  SubscriptionFrequency,
  WalletStatus,
  SubscriptionRunStatus,
  FacilitatorWalletStatus,
  PaymentPullStatus,
  RegistrarWalletStatus,
  LlmProvider,
  RuntimeMode,
  LlmBilling,
  SpendAction,
  AgentSpendStatus,
  LlmBillingTreasuryWalletStatus,
  LlmCallKind,
  PipelineExecutionMode,
  PipelineStatus,
  PipelineStepRole,
  PipelineStepStatus,
  Prisma,
} from "./generated/prisma/client";
import type {
  Subscription,
  SubscriptionWallet,
  SubscriptionRun,
  FacilitatorWallet,
  PaymentPull,
  AgentWallet,
  RegistrarWallet,
  CircleOwnerWallet,
  AgentLlmKey,
  HostedRuntimeConfig,
  AgentSpendPolicy,
  AgentSpendLog,
  AgentLlmUsage,
  LlmBillingTreasuryWallet,
  AgentLlmCredit,
  AgentX402Redemption,
  Pipeline,
  PipelineWallet,
  PipelineStep,
  KnowledgeUsage,
} from "./generated/prisma/client";

// Standard Next.js/Prisma singleton pattern: without it, every hot-reload in dev creates a
// fresh PrismaClient (and a fresh connection pool) without closing the last one.
const globalForPrisma = globalThis as unknown as { __clawdhqCustodyPrisma?: PrismaClient };

export const prisma = globalForPrisma.__clawdhqCustodyPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__clawdhqCustodyPrisma = prisma;
}

// Generated into a custom output dir (not node_modules/@prisma/client) — see the `output`
// comment in prisma/schema.prisma for why. Named re-exports, not `export *`: the generated
// client is CommonJS, and a wildcard re-export of a CJS module forces bundlers into an
// unoptimizable runtime proxy (Turbopack flags this explicitly) — naming the actual surface
// consumers use avoids that and keeps the package's API intentional.
export {
  Chain,
  SubscriptionFrequency,
  WalletStatus,
  SubscriptionRunStatus,
  FacilitatorWalletStatus,
  PaymentPullStatus,
  RegistrarWalletStatus,
  LlmProvider,
  RuntimeMode,
  LlmBilling,
  SpendAction,
  AgentSpendStatus,
  LlmBillingTreasuryWalletStatus,
  LlmCallKind,
  PipelineExecutionMode,
  PipelineStatus,
  PipelineStepRole,
  PipelineStepStatus,
  Prisma,
};
export type {
  Subscription,
  SubscriptionWallet,
  SubscriptionRun,
  FacilitatorWallet,
  PaymentPull,
  AgentWallet,
  RegistrarWallet,
  CircleOwnerWallet,
  AgentLlmKey,
  HostedRuntimeConfig,
  AgentSpendPolicy,
  AgentSpendLog,
  AgentLlmUsage,
  LlmBillingTreasuryWallet,
  AgentLlmCredit,
  AgentX402Redemption,
  Pipeline,
  PipelineWallet,
  PipelineStep,
  KnowledgeUsage,
};
