-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSkill_chain_agentChainId_idx" ON "AgentSkill"("chain", "agentChainId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_chain_agentChainId_skillId_key" ON "AgentSkill"("chain", "agentChainId", "skillId");
