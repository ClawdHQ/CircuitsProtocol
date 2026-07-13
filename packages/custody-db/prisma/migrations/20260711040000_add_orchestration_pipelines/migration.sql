-- CreateEnum
CREATE TYPE "PipelineExecutionMode" AS ENUM ('SERIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "PipelineStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PipelineStepRole" AS ENUM ('ORCHESTRATOR', 'WORKER', 'EVALUATOR');

-- CreateEnum
CREATE TYPE "PipelineStepStatus" AS ENUM ('PENDING', 'ATTEMPTING', 'SUBMITTED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "executionMode" "PipelineExecutionMode" NOT NULL,
    "status" "PipelineStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineWallet" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStep" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "agentChainId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "role" "PipelineStepRole" NOT NULL,
    "taskDescription" TEXT NOT NULL,
    "budgetUsdc" DECIMAL(30,10) NOT NULL,
    "deadlineDays" INTEGER NOT NULL DEFAULT 3,
    "status" "PipelineStepStatus" NOT NULL DEFAULT 'PENDING',
    "jobChainId" TEXT,
    "txHashOrRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Pipeline_ownerAddress_idx" ON "Pipeline"("ownerAddress");

-- CreateIndex
CREATE INDEX "Pipeline_status_idx" ON "Pipeline"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineWallet_pipelineId_key" ON "PipelineWallet"("pipelineId");

-- CreateIndex
CREATE INDEX "PipelineStep_pipelineId_position_idx" ON "PipelineStep"("pipelineId", "position");

-- CreateIndex
CREATE INDEX "PipelineStep_jobChainId_idx" ON "PipelineStep"("jobChainId");

-- AddForeignKey
ALTER TABLE "PipelineWallet" ADD CONSTRAINT "PipelineWallet_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStep" ADD CONSTRAINT "PipelineStep_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
