-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('ANTHROPIC', 'OPENAI');

-- CreateEnum
CREATE TYPE "RuntimeMode" AS ENUM ('HOSTED', 'BYO_ENDPOINT');

-- CreateEnum
CREATE TYPE "LlmBilling" AS ENUM ('PLATFORM', 'BYO_KEY');

-- CreateEnum
CREATE TYPE "SpendAction" AS ENUM ('POST_JOB', 'X402_PAYMENT');

-- CreateEnum
CREATE TYPE "AgentSpendStatus" AS ENUM ('PENDING', 'ATTEMPTING', 'SUBMITTED', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentLlmKey" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentLlmKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostedRuntimeConfig" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "mode" "RuntimeMode" NOT NULL DEFAULT 'HOSTED',
    "llmBilling" "LlmBilling" NOT NULL DEFAULT 'PLATFORM',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "nextTickAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastTickAt" TIMESTAMP(3),
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostedRuntimeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSpendPolicy" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "dailyCapUsdc" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "allowedActions" "SpendAction"[],
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSpendPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSpendLog" (
    "id" TEXT NOT NULL,
    "agentSpendPolicyId" TEXT NOT NULL,
    "action" "SpendAction" NOT NULL,
    "amountUsdc" DECIMAL(30,10) NOT NULL,
    "targetRef" TEXT,
    "status" "AgentSpendStatus" NOT NULL DEFAULT 'PENDING',
    "txHashOrRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSpendLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentLlmUsage" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costUsdc" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentLlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentLlmKey_chain_agentChainId_key" ON "AgentLlmKey"("chain", "agentChainId");

-- CreateIndex
CREATE UNIQUE INDEX "HostedRuntimeConfig_chain_agentChainId_key" ON "HostedRuntimeConfig"("chain", "agentChainId");

-- CreateIndex
CREATE INDEX "HostedRuntimeConfig_isActive_nextTickAt_idx" ON "HostedRuntimeConfig"("isActive", "nextTickAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSpendPolicy_chain_agentChainId_key" ON "AgentSpendPolicy"("chain", "agentChainId");

-- CreateIndex
CREATE INDEX "AgentSpendLog_agentSpendPolicyId_createdAt_idx" ON "AgentSpendLog"("agentSpendPolicyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentLlmUsage_chain_agentChainId_periodStart_key" ON "AgentLlmUsage"("chain", "agentChainId", "periodStart");

-- AddForeignKey
ALTER TABLE "AgentSpendLog" ADD CONSTRAINT "AgentSpendLog_agentSpendPolicyId_fkey" FOREIGN KEY ("agentSpendPolicyId") REFERENCES "AgentSpendPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
