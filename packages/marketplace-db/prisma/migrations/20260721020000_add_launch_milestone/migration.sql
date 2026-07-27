-- CreateTable
CREATE TABLE "LaunchMilestone" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "launchChainId" TEXT NOT NULL,
    "lastMilestoneUsdc" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaunchMilestone_chain_launchChainId_key" ON "LaunchMilestone"("chain", "launchChainId");
