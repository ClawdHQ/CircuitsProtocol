-- CreateTable
CREATE TABLE "KnowledgeUsage" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "ownerProfileId" TEXT NOT NULL,
    "ownerPayoutAddress" TEXT NOT NULL,
    "consumerChain" "Chain" NOT NULL,
    "consumerAgentChainId" TEXT NOT NULL,
    "priceUsdc" DECIMAL(30,10) NOT NULL,
    "ownerShareUsdc" DECIMAL(30,10) NOT NULL,
    "protocolShareUsdc" DECIMAL(30,10) NOT NULL,
    "ownerPullId" TEXT NOT NULL,
    "protocolPullId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeUsage_ownerPullId_key" ON "KnowledgeUsage"("ownerPullId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeUsage_protocolPullId_key" ON "KnowledgeUsage"("protocolPullId");

-- CreateIndex
CREATE INDEX "KnowledgeUsage_contributionId_idx" ON "KnowledgeUsage"("contributionId");

-- CreateIndex
CREATE INDEX "KnowledgeUsage_ownerProfileId_createdAt_idx" ON "KnowledgeUsage"("ownerProfileId", "createdAt");
