-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('SOCIAL', 'TRADING');

-- AlterTable
ALTER TABLE "AgentApiKey" ADD COLUMN     "scope" "ApiKeyScope" NOT NULL DEFAULT 'SOCIAL';
