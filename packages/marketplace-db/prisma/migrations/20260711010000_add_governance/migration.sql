-- CreateEnum
CREATE TYPE "ProposalCategory" AS ENUM ('PARAMETERS', 'TREASURY', 'UPGRADE', 'SKILL', 'OTHER');

-- CreateEnum
CREATE TYPE "ProposalState" AS ENUM ('ACTIVE', 'SUCCEEDED', 'DEFEATED', 'QUORUM_NOT_MET', 'CANCELED', 'EXECUTED');

-- CreateTable
CREATE TABLE "GovernanceProposal" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "chainProposalId" TEXT NOT NULL,
    "proposer" TEXT NOT NULL,
    "proposerAgentChainId" TEXT NOT NULL,
    "category" "ProposalCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "state" "ProposalState" NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "quorumRequired" BIGINT NOT NULL,
    "votesFor" BIGINT NOT NULL,
    "votesAgainst" BIGINT NOT NULL,
    "createdAtChain" TIMESTAMP(3) NOT NULL,
    "updatedAtChain" TIMESTAMP(3) NOT NULL,
    "lastIndexedAt" BIGINT,

    CONSTRAINT "GovernanceProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceVote" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "proposalDbId" TEXT NOT NULL,
    "voterAgentChainId" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "support" BOOLEAN NOT NULL,
    "weight" BIGINT NOT NULL,
    "createdAtChain" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceProposal_chain_chainProposalId_key" ON "GovernanceProposal"("chain", "chainProposalId");

-- CreateIndex
CREATE INDEX "GovernanceProposal_chain_state_idx" ON "GovernanceProposal"("chain", "state");

-- CreateIndex
CREATE INDEX "GovernanceProposal_proposerAgentChainId_idx" ON "GovernanceProposal"("proposerAgentChainId");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceVote_chain_proposalDbId_voterAgentChainId_key" ON "GovernanceVote"("chain", "proposalDbId", "voterAgentChainId");

-- CreateIndex
CREATE INDEX "GovernanceVote_proposalDbId_idx" ON "GovernanceVote"("proposalDbId");

-- AddForeignKey
ALTER TABLE "GovernanceVote" ADD CONSTRAINT "GovernanceVote_proposalDbId_fkey" FOREIGN KEY ("proposalDbId") REFERENCES "GovernanceProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
