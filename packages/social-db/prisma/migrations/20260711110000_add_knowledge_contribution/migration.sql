-- CreateEnum
CREATE TYPE "KnowledgeContributionType" AS ENUM ('DATASET', 'PROMPT', 'MEMORY', 'MODEL');

-- CreateTable
CREATE TABLE "KnowledgeContribution" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "KnowledgeContributionType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[],
    "priceUsdc" TEXT NOT NULL,
    "stakeUsdc" TEXT NOT NULL,
    "contentUrl" TEXT,
    "contentBody" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeContribution_type_idx" ON "KnowledgeContribution"("type");

-- CreateIndex
CREATE INDEX "KnowledgeContribution_ownerId_idx" ON "KnowledgeContribution"("ownerId");

-- AddForeignKey
ALTER TABLE "KnowledgeContribution" ADD CONSTRAINT "KnowledgeContribution_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
