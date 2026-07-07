// BullMQ producer side of notification-jobs: the adapter that makes the abstract
// Notifier port durable. itemService calls `notifyCompletion`; instead of hitting
// Slack inline, this enqueues a job onto Redis with retry/backoff so the worker
// delivers it even across a transient Slack outage or a web-process restart.

import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Notifier } from "../services/ports";
import { bullConnection } from "./connection";
import {
  NOTIFICATION_QUEUE_NAME,
  type CompletionDmJob,
  type NotificationJob,
} from "./notificationQueue";

export interface NotificationQueue extends Notifier {
  /** Low-level enqueue, for job types beyond the Notifier surface. */
  enqueue(job: NotificationJob): Promise<void>;
  /** Release the underlying Redis connection (graceful web-process shutdown). */
  close(): Promise<void>;
}

// Retry-safety is the whole point of routing notifications through a queue: a
// failed delivery is retried with exponential backoff rather than silently lost.
// Completed jobs are trimmed so the list can't grow unbounded; a bounded tail of
// failures is retained for debugging a genuinely dead notification.
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

export function createNotificationQueue(connection: Redis): NotificationQueue {
  const queue = new Queue<NotificationJob>(NOTIFICATION_QUEUE_NAME, {
    connection: bullConnection(connection),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  async function enqueue(job: NotificationJob): Promise<void> {
    await queue.add(job.type, job);
  }

  return {
    enqueue,
    async notifyCompletion(notification): Promise<void> {
      const job: CompletionDmJob = { type: "completion-dm", ...notification };
      await enqueue(job);
    },
    close: () => queue.close(),
  };
}
