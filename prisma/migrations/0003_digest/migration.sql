-- Scheduled staleness digest history. One row per channel digest run (never 1:1),
-- so empty/failed runs stay visible and cadence can be reviewed. Cascades when the
-- channel is deleted. summaryText/postedMessageTs are null when a run found nothing
-- stale or the post failed.

-- CreateTable
CREATE TABLE "digest_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "itemsConsidered" INTEGER NOT NULL,
    "staleItems" INTEGER NOT NULL,
    "summaryText" TEXT,
    "postedMessageTs" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "digest_runs_channelId_runAt_idx" ON "digest_runs"("channelId", "runAt");

-- AddForeignKey
ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
