-- CreateTable
CREATE TABLE "MasterPassword" (
    "id" SERIAL NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MasterPassword_pkey" PRIMARY KEY ("id")
);
