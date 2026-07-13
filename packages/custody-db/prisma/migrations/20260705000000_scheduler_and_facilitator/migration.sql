-- CreateEnum
CREATE TYPE "FacilitatorWalletStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "PaymentPullStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubscriptionRun" ADD COLUMN     "jobResolved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FacilitatorWallet" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "FacilitatorWalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilitatorWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPull" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "payerAddress" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "amountUsdc" DECIMAL(30,10) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PaymentPullStatus" NOT NULL,
    "txHashOrRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentPull_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FacilitatorWallet_address_key" ON "FacilitatorWallet"("address");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPull_idempotencyKey_key" ON "PaymentPull"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentPull_payerAddress_createdAt_idx" ON "PaymentPull"("payerAddress", "createdAt");

