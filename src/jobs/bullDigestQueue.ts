// BullMQ producer for digest-jobs. Unlike triage/notifications (enqueued per
// event by the web process), digests are driven by a single *repeatable* sweep
// job that the worker fans out into per-channel jobs. `scheduleSweep` registers
// that repeatable; `enqueueChannel` is what the worker calls for each channel it
// finds during a sweep.

import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { bullConnection } from "./connection";
import {
  DIGEST_QUEUE_NAME,
  type ChannelDigestJob,
  type DigestChannelRef,
  type DigestJob,
  type DigestSweepJob,
} from "./digestQueue";

/** Stable name/id for the single repeatable sweep, so re-scheduling never duplicates it. */
export const DIGEST_SWEEP_NAME = "digest-sweep";

export interface DigestQueue {
  /** Register (or update) the repeatable sweep on the given cron pattern (UTC). */
  scheduleSweep(cronPattern: string): Promise<void>;
  /** Enqueue a digest for one channel (called by the worker while handling a sweep). */
  enqueueChannel(ref: DigestChannelRef): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 500,
};

export function createDigestQueue(connection: Redis): DigestQueue {
  const queue = new Queue<DigestJob>(DIGEST_QUEUE_NAME, {
    connection: bullConnection(connection),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return {
    async scheduleSweep(cronPattern: string): Promise<void> {
      const job: DigestSweepJob = { type: "digest-sweep" };
      await queue.add(DIGEST_SWEEP_NAME, job, {
        repeat: { pattern: cronPattern },
        jobId: DIGEST_SWEEP_NAME,
      });
    },
    async enqueueChannel(ref: DigestChannelRef): Promise<void> {
      const job: ChannelDigestJob = { type: "channel-digest", ...ref };
      await queue.add(job.type, job);
    },
    close: () => queue.close(),
  };
}
