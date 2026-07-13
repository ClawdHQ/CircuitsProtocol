-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "LaunchTrade" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "launchChainId" TEXT NOT NULL,
    "traderAddress" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "tokenAmount" BIGINT NOT NULL,
    "usdcAmount" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAtChain" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LaunchTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaunchTrade_chain_txHash_logIndex_key" ON "LaunchTrade"("chain", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "LaunchTrade_traderAddress_idx" ON "LaunchTrade"("traderAddress");

-- CreateIndex
CREATE INDEX "LaunchTrade_chain_launchChainId_idx" ON "LaunchTrade"("chain", "launchChainId");
