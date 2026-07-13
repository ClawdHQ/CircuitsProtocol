-- CreateTable
CREATE TABLE "CircleOwnerWallet" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'ARC_TESTNET',
    "walletSetId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleOwnerWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CircleOwnerWallet_ownerAddress_chain_key" ON "CircleOwnerWallet"("ownerAddress", "chain");
