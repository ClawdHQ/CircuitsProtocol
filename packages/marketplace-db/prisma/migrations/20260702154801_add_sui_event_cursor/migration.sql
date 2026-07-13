/*
  Warnings:

  - You are about to drop the column `lastCheckpoint` on the `IndexerCursor` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "IndexerCursor" DROP COLUMN "lastCheckpoint",
ADD COLUMN     "lastEventCursor" TEXT;
