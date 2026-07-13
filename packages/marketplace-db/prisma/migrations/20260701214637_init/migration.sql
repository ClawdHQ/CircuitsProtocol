-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('BSC_TESTNET', 'BASE_SEPOLIA', 'ETH_SEPOLIA', 'SOLANA_DEVNET', 'SUI_TESTNET');

-- CreateEnum
CREATE TYPE "ListingMode" AS ENUM ('OPEN', 'AUCTION');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "chainListingId" TEXT NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "mode" "ListingMode" NOT NULL,
    "status" "ListingStatus" NOT NULL,
    "fairValueSnapshotUsdc" BIGINT NOT NULL,
    "reservePriceUsdc" BIGINT NOT NULL,
    "endTime" TIMESTAMP(3),
    "highestBidChainId" TEXT,
    "createdAtChain" TIMESTAMP(3) NOT NULL,
    "updatedAtChain" TIMESTAMP(3) NOT NULL,
    "lastIndexedAt" BIGINT,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "chainBidId" TEXT NOT NULL,
    "listingDbId" TEXT NOT NULL,
    "bidder" TEXT NOT NULL,
    "amountUsdc" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "createdAtChain" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentValuationCache" (
    "chain" "Chain" NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "fairValueUsdc" BIGINT NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentValuationCache_pkey" PRIMARY KEY ("chain","agentChainId")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "chain" "Chain" NOT NULL,
    "lastBlock" BIGINT,
    "lastSlot" BIGINT,
    "lastCheckpoint" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("chain")
);

-- CreateIndex
CREATE INDEX "Listing_chain_status_idx" ON "Listing"("chain", "status");

-- CreateIndex
CREATE INDEX "Listing_agentChainId_idx" ON "Listing"("agentChainId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_chain_chainListingId_key" ON "Listing"("chain", "chainListingId");

-- CreateIndex
CREATE INDEX "Bid_listingDbId_idx" ON "Bid"("listingDbId");

-- CreateIndex
CREATE UNIQUE INDEX "Bid_chain_chainBidId_key" ON "Bid"("chain", "chainBidId");

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_listingDbId_fkey" FOREIGN KEY ("listingDbId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
