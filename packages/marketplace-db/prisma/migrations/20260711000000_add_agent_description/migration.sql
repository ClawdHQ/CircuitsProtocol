-- CreateTable
CREATE TABLE "AgentDescription" (
    "metadataHash" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDescription_pkey" PRIMARY KEY ("metadataHash")
);
