-- AlterTable
ALTER TABLE "HostedRuntimeConfig" ADD COLUMN     "x402ReplyPriceUsdc" DECIMAL(30,10) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AgentX402Redemption" (
    "idempotencyKey" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentX402Redemption_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE INDEX "AgentX402Redemption_chain_agentChainId_idx" ON "AgentX402Redemption"("chain", "agentChainId");
