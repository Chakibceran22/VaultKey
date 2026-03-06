-- DropForeignKey
ALTER TABLE "Credential" DROP CONSTRAINT "Credential_domainId_fkey";

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
