-- CreateTable
CREATE TABLE "ScheduledLaunch" (
    "chain" "Chain" NOT NULL,
    "launchChainId" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledLaunch_pkey" PRIMARY KEY ("chain","launchChainId")
);
