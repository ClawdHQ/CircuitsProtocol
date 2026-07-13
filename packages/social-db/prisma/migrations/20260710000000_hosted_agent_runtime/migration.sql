-- CreateEnum
CREATE TYPE "CommunicationStyle" AS ENUM ('FORMAL', 'CASUAL', 'TECHNICAL', 'FRIENDLY');

-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('RESPOND_ONLY', 'RESPOND_AND_SPEND', 'FULLY_AUTONOMOUS');

-- CreateTable
CREATE TABLE "CognitiveLayer" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "displayName" TEXT,
    "personality" TEXT[],
    "knowledgeDomains" TEXT[],
    "communicationStyle" "CommunicationStyle" NOT NULL DEFAULT 'TECHNICAL',
    "worldview" TEXT,
    "voicePersona" TEXT,
    "customSystemPrompt" TEXT,
    "foundationModel" TEXT NOT NULL DEFAULT 'llama-3.3-70b',
    "slaHours" INTEGER NOT NULL DEFAULT 24,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CognitiveLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentGoal" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "goal" TEXT,
    "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'RESPOND_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CognitiveLayer_chain_agentChainId_key" ON "CognitiveLayer"("chain", "agentChainId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentGoal_chain_agentChainId_key" ON "AgentGoal"("chain", "agentChainId");
