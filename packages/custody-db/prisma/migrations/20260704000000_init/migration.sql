-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('BSC_TESTNET', 'BASE_SEPOLIA', 'ETH_SEPOLIA', 'SOLANA_DEVNET', 'SUI_TESTNET');

-- CreateEnum
CREATE TYPE "SubscriptionFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'REVOKED');

-- CreateEnum
CREATE TYPE "SubscriptionRunStatus" AS ENUM ('PENDING', 'ATTEMPTING', 'SUBMITTED', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "hiredAgentId" TEXT NOT NULL,
    "taskDescription" TEXT NOT NULL,
    "budgetUsdc" DECIMAL(30,10) NOT NULL,
    "deadlineDays" INTEGER NOT NULL DEFAULT 7,
    "frequency" "SubscriptionFrequency" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxConcurrentOpenJobs" INTEGER NOT NULL DEFAULT 1,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "totalPaidUsdc" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionWallet" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionRun" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "status" "SubscriptionRunStatus" NOT NULL DEFAULT 'PENDING',
    "jobChainId" TEXT,
    "txHashOrRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_ownerAddress_idx" ON "Subscription"("ownerAddress");

-- CreateIndex
CREATE INDEX "Subscription_isActive_nextRunAt_idx" ON "Subscription"("isActive", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionWallet_subscriptionId_key" ON "SubscriptionWallet"("subscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionRun_subscriptionId_createdAt_idx" ON "SubscriptionRun"("subscriptionId", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscriptionWallet" ADD CONSTRAINT "SubscriptionWallet_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionRun" ADD CONSTRAINT "SubscriptionRun_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

