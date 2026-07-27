// BullMQ producer side of triage-jobs: the web process enqueues one job per
// newly-added item and returns immediately, so the LLM triage pass happens in the
// worker instead of on Slack's 3-second ack path.

import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { bullConnection } from "./connection";
import { TRIAGE_QUEUE_NAME, type TriageItemJob, type TriageJob } from "./triageQueue";

export interface TriageQueue {
  /** Enqueue triage for a newly-created item. */
  enqueueItem(workspaceId: string, itemId: string): Promise<void>;
  /** Release the underlying Redis connection (graceful web-process shutdown). */
  close(): Promise<void>;
}

// Triage is best-effort: a failed run is retried a few times with backoff, then
// left as a bounded failure record. Fewer attempts than notifications — a lost
// summary is a soft miss, not a dropped user-facing notification.
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000,
};

export function createTriageQueue(connection: Redis): TriageQueue {
  const queue = new Queue<TriageJob>(TRIAGE_QUEUE_NAME, {
    connection: bullConnection(connection),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return {
    async enqueueItem(workspaceId: string, itemId: string): Promise<void> {
      const job: TriageItemJob = { type: "triage-item", workspaceId, itemId };
      await queue.add(job.type, job);
    },
    close: () => queue.close(),
  };
}
