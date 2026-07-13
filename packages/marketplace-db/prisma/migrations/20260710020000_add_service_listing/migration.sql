-- CreateEnum
CREATE TYPE "ServiceListingStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateTable
CREATE TABLE "ServiceListing" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "priceUsdcMicros" BIGINT NOT NULL,
    "status" "ServiceListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCall" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "callerAddress" TEXT NOT NULL,
    "priceUsdcMicros" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceListing_chain_status_idx" ON "ServiceListing"("chain", "status");

-- CreateIndex
CREATE INDEX "ServiceListing_agentChainId_idx" ON "ServiceListing"("agentChainId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCall_txHash_key" ON "ServiceCall"("txHash");

-- CreateIndex
CREATE INDEX "ServiceCall_listingId_idx" ON "ServiceCall"("listingId");

-- AddForeignKey
ALTER TABLE "ServiceCall" ADD CONSTRAINT "ServiceCall_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ServiceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
