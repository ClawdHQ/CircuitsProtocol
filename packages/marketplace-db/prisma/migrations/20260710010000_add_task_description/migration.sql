-- CreateTable
CREATE TABLE "TaskDescription" (
    "taskHash" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskDescription_pkey" PRIMARY KEY ("taskHash")
);
