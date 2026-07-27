-- AlterTable
ALTER TABLE "ServiceListing"
  ADD COLUMN "feeTxHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ServiceListing_feeTxHash_key" ON "ServiceListing"("feeTxHash");
