-- Migration 0029 was amended after some development databases had already
-- applied its original form. Bring those databases forward without relying on
-- an already-recorded migration being replayed.

UPDATE "member"
SET "role" = 'viewer'
WHERE "role" = 'member';

ALTER TABLE "member"
  ALTER COLUMN "role" SET DEFAULT 'viewer';

ALTER TABLE "member"
  DROP CONSTRAINT IF EXISTS "member_role_valid";

ALTER TABLE "member"
  ADD CONSTRAINT "member_role_valid"
  CHECK ("role" IN ('owner', 'admin', 'editor', 'viewer'));

DROP INDEX IF EXISTS "account_provider_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_unique"
  ON "account" ("provider_id", "account_id");

ALTER TABLE "api_key"
  ADD COLUMN IF NOT EXISTS "organization_id" UUID;

-- Preserve legacy credentials when their organization can be inferred
-- unambiguously from a single membership.
UPDATE "api_key" AS "credential"
SET "organization_id" = "membership"."organization_id"
FROM (
  SELECT
    "user_id",
    MIN("organization_id"::TEXT)::UUID AS "organization_id"
  FROM "member"
  GROUP BY "user_id"
  HAVING COUNT(*) = 1
) AS "membership"
WHERE "credential"."organization_id" IS NULL
  AND "credential"."user_id" = "membership"."user_id";

-- Refuse to guess when a legacy credential has no unique tenant. The
-- transaction rolls back intact and the operator can explicitly revoke or
-- assign those credentials before retrying the migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "api_key"
    WHERE "organization_id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Legacy API credentials require an explicit organization assignment before migration';
  END IF;
END
$$;

ALTER TABLE "api_key"
  ALTER COLUMN "organization_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'api_key_organization_id_organization_id_fk'
  ) THEN
    ALTER TABLE "api_key"
      ADD CONSTRAINT "api_key_organization_id_organization_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "api_key_organization_idx"
  ON "api_key" ("organization_id");
