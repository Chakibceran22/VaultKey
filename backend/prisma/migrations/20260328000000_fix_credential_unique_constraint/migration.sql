-- Drop the old unique constraint on email only
DROP INDEX IF EXISTS "Credential_email_key";

-- Add the correct compound unique constraint on (email, domainId)
CREATE UNIQUE INDEX "Credential_email_domainId_key" ON "Credential"(email, "domainId");
