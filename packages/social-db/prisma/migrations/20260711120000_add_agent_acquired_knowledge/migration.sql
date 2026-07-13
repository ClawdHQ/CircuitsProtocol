-- CreateTable
CREATE TABLE "AgentAcquiredKnowledge" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "contributionTitle" TEXT NOT NULL,
    "contributionType" "KnowledgeContributionType" NOT NULL,
    "content" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAcquiredKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAcquiredKnowledge_chain_agentChainId_acquiredAt_idx" ON "AgentAcquiredKnowledge"("chain", "agentChainId", "acquiredAt");
