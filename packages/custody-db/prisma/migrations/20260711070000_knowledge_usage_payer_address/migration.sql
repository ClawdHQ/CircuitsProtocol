-- AlterTable
ALTER TABLE "KnowledgeUsage" ADD COLUMN "consumerPayerAddress" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "KnowledgeUsage" ALTER COLUMN "consumerAgentChainId" DROP NOT NULL;
