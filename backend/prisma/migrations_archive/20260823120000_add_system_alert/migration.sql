-- SystemAlert: deduplicated admin operational alerts

CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemAlert_key_resolved_key" ON "SystemAlert"("key", "resolved");

CREATE INDEX "SystemAlert_severity_acknowledgedAt_idx" ON "SystemAlert"("severity", "acknowledgedAt");
