-- CreateEnum
CREATE TYPE "SkillEndpointKind" AS ENUM ('HTTP', 'MCP');

-- CreateEnum
CREATE TYPE "SkillHttpMethod" AS ENUM ('GET', 'POST');

-- CreateTable
CREATE TABLE "PublishedSkill" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "desc" TEXT NOT NULL,
    "cat" TEXT NOT NULL,
    "priceUsdc" TEXT NOT NULL,
    "endpointKind" "SkillEndpointKind",
    "endpointUrl" TEXT,
    "httpMethod" "SkillHttpMethod",
    "paramsJson" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishedSkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublishedSkill_cat_idx" ON "PublishedSkill"("cat");

-- CreateIndex
CREATE INDEX "PublishedSkill_creatorId_idx" ON "PublishedSkill"("creatorId");

-- AddForeignKey
ALTER TABLE "PublishedSkill" ADD CONSTRAINT "PublishedSkill_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
