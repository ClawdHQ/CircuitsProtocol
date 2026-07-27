-- CreateTable
CREATE TABLE "ClawdHqLink" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "clawdhqAgentId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "walletLinked" BOOLEAN NOT NULL DEFAULT false,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClawdHqLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClawdHqLink_chain_agentChainId_key" ON "ClawdHqLink"("chain", "agentChainId");
