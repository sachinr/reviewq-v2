// End-to-end round-trip of the notification-jobs queue against a REAL Redis:
// enqueue a completion-dm through the BullMQ producer, let the worker pick it up,
// and assert the delivery reached a (fake) SlackGateway. This is the piece the
// pure unit tests can't cover — that the producer/worker/BullMQ wiring actually
// moves a job from web → worker. It is gated on REDIS_URL so it only runs in CI
// (or locally with Redis up); with no REDIS_URL the whole suite is skipped, never
// failed, keeping the sandbox suite green.

import type { Worker } from "bullmq";
import { createNotificationQueue, type NotificationQueue } from "../../src/jobs/bullNotificationQueue";
import { createNotificationWorker } from "../../src/jobs/worker";
import { createRedisConnection } from "../../src/jobs/connection";
import { NOTIFICATION_QUEUE_NAME, type NotificationJob } from "../../src/jobs/notificationQueue";
import { FakeSlackGateway } from "../fakes";
import type { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
const describeIf = REDIS_URL ? describe : describe.skip;

describeIf("notification-jobs queue (integration, REDIS_URL)", () => {
  let producerConn: Redis;
  let workerConn: Redis;
  let queue: NotificationQueue;
  let worker: Worker<NotificationJob>;

  beforeAll(async () => {
    producerConn = createRedisConnection(REDIS_URL as string);
    workerConn = createRedisConnection(REDIS_URL as string);
    // Start from a clean queue so a prior run's jobs can't bleed in.
    await obliterate(producerConn);
    queue = createNotificationQueue(producerConn);
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await producerConn?.quit();
    await workerConn?.quit();
  });

  it("delivers an enqueued completion-dm through the worker to the Slack gateway", async () => {
    const slack = new FakeSlackGateway();

    // Capture the delivery: resolve once the worker has run our job's gateway.
    const delivered = new Promise<void>((resolve) => {
      worker = createNotificationWorker({
        connection: workerConn,
        async gatewayForWorkspace(workspaceId) {
          expect(workspaceId).toBe("ws_integration");
          // Return a gateway that records, then flags completion after the post.
          return {
            ...slack,
            postMessage: async (channel: string, text: string) => {
              await slack.postMessage(channel, text);
              resolve();
            },
          } as unknown as FakeSlackGateway;
        },
      });
    });

    await queue.notifyCompletion({
      workspaceId: "ws_integration",
      recipientSlackId: "U_AUTHOR",
      text: ":white_check_mark: done",
    });

    await delivered;

    const posts = slack.callsTo("postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].args[0]).toBe("U_AUTHOR");
    expect(posts[0].args[1]).toContain("done");
  }, 20_000);
});

// Wipe every job from the shared queue name so repeated CI runs are independent.
async function obliterate(connection: Redis): Promise<void> {
  const { Queue } = await import("bullmq");
  const { bullConnection } = await import("../../src/jobs/connection");
  const q = new Queue(NOTIFICATION_QUEUE_NAME, { connection: bullConnection(connection) });
  await q.obliterate({ force: true });
  await q.close();
}
