-- CreateEnum
CREATE TYPE "CrossChainRelayStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "CrossChainRelay" (
    "id" TEXT NOT NULL,
    "sourceChain" "Chain" NOT NULL,
    "sourceTxHash" TEXT NOT NULL,
    "status" "CrossChainRelayStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossChainRelay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrossChainRelay_status_idx" ON "CrossChainRelay"("status");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "CrossChainRelay_sourceChain_sourceTxHash_key" ON "CrossChainRelay"("sourceChain", "sourceTxHash");
