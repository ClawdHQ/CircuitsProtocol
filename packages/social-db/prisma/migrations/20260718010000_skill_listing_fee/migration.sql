-- AlterTable
ALTER TABLE "PublishedSkill"
  ADD COLUMN "feeChain" "Chain",
  ADD COLUMN "feeTxHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PublishedSkill_feeTxHash_key" ON "PublishedSkill"("feeTxHash");
