-- CreateEnum
CREATE TYPE "AgentWalletCustodyType" AS ENUM ('LOCAL', 'CIRCLE');

-- AlterTable
ALTER TABLE "AgentWallet"
  ADD COLUMN "custodyType" "AgentWalletCustodyType" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN "circleWalletId" TEXT,
  ADD COLUMN "circleCredentialId" TEXT,
  ALTER COLUMN "encryptedPrivateKey" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CircleAgentWalletCredential" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "encryptedEntitySecret" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleAgentWalletCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingCircleAgentWalletIntent" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "circleWalletId" TEXT NOT NULL,
    "circleCredentialId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "PendingCircleAgentWalletIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CircleAgentWalletCredential_ownerAddress_key" ON "CircleAgentWalletCredential"("ownerAddress");

-- CreateIndex
CREATE UNIQUE INDEX "PendingCircleAgentWalletIntent_chain_ownerAddress_key" ON "PendingCircleAgentWalletIntent"("chain", "ownerAddress");

-- AddForeignKey
ALTER TABLE "AgentWallet" ADD CONSTRAINT "AgentWallet_circleCredentialId_fkey" FOREIGN KEY ("circleCredentialId") REFERENCES "CircleAgentWalletCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
