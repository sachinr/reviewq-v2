// notification-jobs — the retry-safe transport for outbound Slack notifications.
//
// The classic app fired every notification as a synchronous, unretried
// chat.postMessage; a transient network blip or Slack 5xx silently dropped the
// author's "your message was completed" DM. The plan calls background jobs "the
// single biggest structural gap in the old app". This module is the pure core of
// that gap's fix: the job payloads, the queue name, and a handler that performs
// the outbound call given an already-resolved SlackGateway. It imports neither
// BullMQ nor Redis, so `runNotificationJob` is unit-tested against the same
// FakeSlackGateway the rest of the core uses; the BullMQ Queue/Worker that give
// it durability + retries live in the adapter files next to it.

import type { SlackGateway } from "../services/ports";

/** BullMQ queue name. Shared by the producer (web) and the worker process. */
export const NOTIFICATION_QUEUE_NAME = "notification-jobs";

/**
 * DM the original author that their flagged message was completed by someone
 * else. `workspaceId` is the internal Workspace id so the worker can look up and
 * decrypt that workspace's bot token to build the delivering client.
 */
export interface CompletionDmJob {
  type: "completion-dm";
  workspaceId: string;
  recipientSlackId: string;
  text: string;
}

/**
 * All notification-jobs payloads. A discriminated union so new outbound
 * notifications (Phase 3 staleness digests, clarification pings) slot in without
 * changing the worker's plumbing — only `runNotificationJob`'s switch grows.
 * Every variant carries `workspaceId` for the same per-workspace client lookup.
 */
export type NotificationJob = CompletionDmJob;

/**
 * Perform one notification job's outbound Slack call. Pure w.r.t. infrastructure:
 * it takes the workspace's SlackGateway already resolved by the caller and does
 * the delivery. Any error thrown propagates to BullMQ, which is exactly what
 * drives the retry/backoff — so this deliberately does NOT swallow failures.
 */
export async function runNotificationJob(job: NotificationJob, slack: SlackGateway): Promise<void> {
  switch (job.type) {
    case "completion-dm":
      await slack.postMessage(job.recipientSlackId, job.text);
      return;
    default: {
      // Exhaustiveness guard: a new job type that forgets a case fails to compile.
      const unreachable: never = job.type;
      throw new Error(`Unknown notification job type: ${String(unreachable)}`);
    }
  }
}
