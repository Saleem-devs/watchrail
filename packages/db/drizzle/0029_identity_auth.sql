-- Better Auth core tables: user, session, account, verification
-- Organization plugin tables: organization, member, invitation
-- API key plugin table: api_key

CREATE TABLE "user" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "email_verified" BOOLEAN NOT NULL DEFAULT FALSE,
  "image" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "session" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "expires_at" TIMESTAMP NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "ip_address" TEXT,
  "user_agent" TEXT,
  "user_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" UUID
);

CREATE TABLE "account" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" TEXT,
  "refresh_token" TEXT,
  "id_token" TEXT,
  "access_token_expires_at" TIMESTAMP,
  "refresh_token_expires_at" TIMESTAMP,
  "scope" TEXT,
  "password" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "verification" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expires_at" TIMESTAMP NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);

-- Organization plugin

CREATE TABLE "organization" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT UNIQUE,
  "logo" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "metadata" TEXT
);

CREATE TABLE "member" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'member',
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "member_organization_user_unique" UNIQUE ("organization_id", "user_id"),
  CONSTRAINT "member_role_valid" CHECK (
    "role" IN ('owner', 'admin', 'editor', 'viewer', 'member')
  )
);

CREATE TABLE "invitation" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMP NOT NULL,
  "inviter_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE "session"
  ADD CONSTRAINT "session_active_organization_id_organization_id_fk"
  FOREIGN KEY ("active_organization_id") REFERENCES "organization"("id")
  ON DELETE SET NULL;

-- API key plugin

CREATE TABLE "api_key" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT,
  "start" TEXT,
  "prefix" TEXT,
  "key" TEXT NOT NULL UNIQUE,
  "user_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "refill_interval" INTEGER,
  "refill_amount" INTEGER,
  "last_refill_at" TIMESTAMP,
  "enabled" BOOLEAN DEFAULT TRUE,
  "rate_limit_enabled" BOOLEAN DEFAULT FALSE,
  "rate_limit_time_window" INTEGER,
  "rate_limit_max" INTEGER,
  "request_count" INTEGER DEFAULT 0,
  "remaining" INTEGER,
  "last_request" TIMESTAMP,
  "expires_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "permissions" TEXT,
  "metadata" TEXT
);

-- Indexes for performance

CREATE INDEX "session_user_id_idx" ON "session" ("user_id");
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");
CREATE INDEX "account_provider_idx" ON "account" ("provider_id", "account_id");
CREATE INDEX "member_organization_idx" ON "member" ("organization_id");
CREATE INDEX "member_user_idx" ON "member" ("user_id");
CREATE INDEX "invitation_organization_idx" ON "invitation" ("organization_id");
CREATE INDEX "api_key_user_idx" ON "api_key" ("user_id");
