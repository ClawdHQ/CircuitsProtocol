-- CreateEnum
CREATE TYPE "LlmBillingTreasuryWalletStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "LlmCallKind" AS ENUM ('REACTIVE_REPLY', 'TICK_DECISION');

-- DropIndex
DROP INDEX "AgentLlmUsage_chain_agentChainId_periodStart_key";

-- AlterTable
-- AgentLlmUsage was defined but never written to by any code path (the metering it was meant to
-- back was never implemented) — safe to reshape from a daily-bucket aggregate into an
-- append-only per-call log without a data migration.
ALTER TABLE "AgentLlmUsage" DROP COLUMN "periodStart",
DROP COLUMN "tokensUsed",
DROP COLUMN "updatedAt",
ADD COLUMN     "callKind" "LlmCallKind" NOT NULL,
ADD COLUMN     "inputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "provider" "LlmProvider" NOT NULL,
ALTER COLUMN "costUsdc" DROP DEFAULT;

-- CreateTable
CREATE TABLE "LlmBillingTreasuryWallet" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "LlmBillingTreasuryWalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmBillingTreasuryWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentLlmCredit" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "balanceUsdc" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentLlmCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LlmBillingTreasuryWallet_address_key" ON "LlmBillingTreasuryWallet"("address");

-- CreateIndex
CREATE UNIQUE INDEX "AgentLlmCredit_chain_agentChainId_key" ON "AgentLlmCredit"("chain", "agentChainId");

-- CreateIndex
CREATE INDEX "AgentLlmUsage_chain_agentChainId_createdAt_idx" ON "AgentLlmUsage"("chain", "agentChainId", "createdAt");
