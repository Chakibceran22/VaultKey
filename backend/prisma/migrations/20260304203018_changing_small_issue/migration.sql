/*
  Warnings:

  - You are about to drop the column `lastTimeUsed` on the `Domain` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Credential" ADD COLUMN     "lastTimeUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Domain" DROP COLUMN "lastTimeUsed";
