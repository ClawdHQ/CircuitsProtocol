-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentUri" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "metadataHash" TEXT NOT NULL,
    "supportsX402" BOOLEAN NOT NULL,
    "supportsA2A" BOOLEAN NOT NULL,
    "supportsMcp" BOOLEAN NOT NULL,
    "active" BOOLEAN NOT NULL,
    "tier" INTEGER NOT NULL,
    "jobsCompleted" INTEGER NOT NULL,
    "jobsFailed" INTEGER NOT NULL,
    "usdcRevenue" BIGINT NOT NULL,
    "reputationBps" INTEGER NOT NULL,
    "lastJobAtChain" TIMESTAMP(3),
    "createdAtChain" TIMESTAMP(3) NOT NULL,
    "updatedAtChain" TIMESTAMP(3) NOT NULL,
    "lastIndexedAt" BIGINT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_chain_agentChainId_key" ON "Agent"("chain", "agentChainId");

-- CreateIndex
CREATE INDEX "Agent_chain_owner_idx" ON "Agent"("chain", "owner");

-- CreateIndex
CREATE INDEX "Agent_chain_active_idx" ON "Agent"("chain", "active");
