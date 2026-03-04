/*
  Warnings:

  - You are about to drop the `MasterPassword` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "MasterPassword";

-- CreateTable
CREATE TABLE "AuthKey" (
    "id" SERIAL NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthKey_pkey" PRIMARY KEY ("id")
);
