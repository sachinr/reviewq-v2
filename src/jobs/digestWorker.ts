// digestWorker — the consumer side of digest-jobs. Runs in the same worker
// process as the notification/triage workers. It handles two job types on one
// queue: a `digest-sweep` (fan out: enumerate channels and enqueue one
// channel-digest each) and a `channel-digest` (run the model pass and post). The
// factory takes its collaborators so the wiring is integration-testable against
// fakes + real Redis without a live Slack token or API key.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { DigestModel } from "../services/digest";
import { bullConnection } from "./connection";
import {
  DIGEST_QUEUE_NAME,
  runChannelDigestJob,
  type DigestChannelRef,
  type DigestJob,
  type DigestStore,
} from "./digestQueue";

export interface DigestWorkerDeps {
  connection: Redis;
  store: DigestStore;
  model: DigestModel;
  /** Enqueue a per-channel digest (the producer's enqueueChannel). */
  enqueueChannel(ref: DigestChannelRef): Promise<void>;
  /** Post the digest to a channel, returning the message ts (null if the post failed). */
  postDigest(
    workspaceId: string,
    slackChannelId: string,
    summaryText: string,
    staleItems: number,
  ): Promise<string | null>;
  /** Injected clock; defaults to the wall clock. */
  clock?(): Date;
}

export function createDigestWorker(deps: DigestWorkerDeps): Worker<DigestJob> {
  const clock = deps.clock ?? (() => new Date());

  return new Worker<DigestJob>(
    DIGEST_QUEUE_NAME,
    async (job) => {
      const data = job.data;
      if (data.type === "digest-sweep") {
        const channels = await deps.store.listDigestChannels();
        for (const ref of channels) {
          await deps.enqueueChannel(ref);
        }
        return;
      }

      await runChannelDigestJob(data, {
        loadOpenItems: (channelId) => deps.store.loadOpenItems(channelId),
        model: deps.model,
        clock,
        post: (slackChannelId, text, staleItems) =>
          deps.postDigest(data.workspaceId, slackChannelId, text, staleItems),
        recordRun: (run) => deps.store.recordRun(run),
      });
    },
    { connection: bullConnection(deps.connection) },
  );
}
