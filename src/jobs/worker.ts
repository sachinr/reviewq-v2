// notificationWorker — the consumer process for notification-jobs. Runs from the
// same image as the web process (package.json `start:worker` → dist/jobs/worker.js)
// but as a separate role, per the plan's three-process deploy (web / worker /
// scheduler). Each job re-resolves the target workspace's bot token and delivers
// the queued Slack call; throwing on failure hands control back to BullMQ, whose
// per-job attempts/backoff (set on the Queue) provide the retry-safety the old
// fire-and-forget path never had.
//
// The processing logic is a factory that takes a `gatewayForWorkspace` resolver
// so it can be integration-tested against a fake gateway + real Redis without a
// live Slack token; the module's bottom half is the production entrypoint that
// wires the resolver to Prisma + the token cipher.

import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { SlackGateway } from "../services/ports";
import { bullConnection } from "./connection";
import { NOTIFICATION_QUEUE_NAME, runNotificationJob, type NotificationJob } from "./notificationQueue";
import { TRIAGE_QUEUE_NAME } from "./triageQueue";
import { DIGEST_QUEUE_NAME } from "./digestQueue";

export interface NotificationWorkerDeps {
  connection: Redis;
  /** Resolve the per-workspace Slack client used to deliver a job. */
  gatewayForWorkspace(workspaceId: string): Promise<SlackGateway>;
}

export function createNotificationWorker(deps: NotificationWorkerDeps): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      const slack = await deps.gatewayForWorkspace(job.data.workspaceId);
      await runNotificationJob(job.data, slack);
    },
    { connection: bullConnection(deps.connection) },
  );
}

// --- Production entrypoint ----------------------------------------------------

async function main(): Promise<void> {
  // Imported lazily so unit/integration tests can pull in the factory above
  // without loading config (which throws on missing env) or opening Prisma.
  const { WebClient } = await import("@slack/web-api");
  const { loadConfig } = await import("../config");
  const { createTokenCipher } = await import("../crypto/tokenCipher");
  const { prisma } = await import("../db/prisma");
  const { SlackClient } = await import("../slack/slackClient");
  const { createRedisConnection } = await import("./connection");
  const { createTriageWorker } = await import("./triageWorker");
  const { createPrismaTriageStore } = await import("../db/triageStore");
  const { createTriageModel } = await import("../llm/client");

  const config = loadConfig();
  const cipher = createTokenCipher(config.tokenEncryptionKey);
  const connection = createRedisConnection(config.redisUrl);

  // Shared per-workspace bot-client resolver: re-mints the WebClient for a live
  // workspace and refuses a dead/uninstalled one so BullMQ stops retrying it.
  async function gatewayForWorkspace(workspaceId: string): Promise<SlackGateway> {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws || !ws.isActive) {
      // A job for an uninstalled workspace: don't retry forever against a dead
      // token — UnrecoverableError skips remaining attempts and fails the job.
      throw new UnrecoverableError(`workspace ${workspaceId} not found or inactive`);
    }
    return new SlackClient(new WebClient(cipher.decrypt(ws.botTokenEncrypted)));
  }

  const worker = createNotificationWorker({ connection, gatewayForWorkspace });

  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`notification job ${job?.id} failed`, err);
  });

  // Triage worker (Phase 2). Only runs the model pass when an API key is
  // configured; without one there's no classifier, so we don't drain the queue.
  let triageWorker: import("bullmq").Worker | undefined;
  if (config.anthropicApiKey) {
    const triageModel = createTriageModel({
      apiKey: config.anthropicApiKey,
      onUsage: (u) => {
        // eslint-disable-next-line no-console
        console.log(
          `💬 triage cost ws=${u.workspaceId} model=${u.model} in=${u.inputTokens} out=${u.outputTokens}`,
        );
      },
    });
    triageWorker = createTriageWorker({
      connection,
      model: triageModel,
      modelName: triageModel.model,
      store: createPrismaTriageStore(prisma),
      gatewayForWorkspace,
      async loadItem(itemId) {
        const it = await prisma.item.findUnique({ where: { id: itemId }, include: { flaggedBy: true } });
        if (!it) return null;
        return {
          id: it.id,
          workspaceId: it.workspaceId,
          messageText: it.messageText,
          permalink: it.permalink,
          flaggedBySlackId: it.flaggedBy?.slackUserId ?? null,
        };
      },
    });
    triageWorker.on("failed", (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`triage job ${job?.id} failed`, err);
    });
  }

  // Digest worker + repeatable sweep (Phase 3). Like triage, it needs a model, so
  // it only runs when an API key is configured. The sweep cron is UTC and
  // overridable; default is Mondays 14:00 UTC.
  let digestWorker: import("bullmq").Worker | undefined;
  let digestQueue: import("./bullDigestQueue").DigestQueue | undefined;
  if (config.anthropicApiKey) {
    const { createDigestModel } = await import("../llm/digestModel");
    const { createPrismaDigestStore } = await import("../db/digestStore");
    const { createDigestQueue } = await import("./bullDigestQueue");
    const { createDigestWorker } = await import("./digestWorker");
    const { digestBlocks } = await import("../slack/blocks");

    const digestModel = createDigestModel({
      apiKey: config.anthropicApiKey,
      onUsage: (u) => {
        // eslint-disable-next-line no-console
        console.log(
          `📰 digest cost ws=${u.workspaceId} model=${u.model} in=${u.inputTokens} out=${u.outputTokens}`,
        );
      },
    });
    const store = createPrismaDigestStore(prisma);
    digestQueue = createDigestQueue(connection);

    // Post the digest with a fresh per-workspace bot client; best-effort — a post
    // failure returns null so the run is still recorded (as a miss) instead of
    // retrying the whole model pass.
    const postDigest = async (
      workspaceId: string,
      slackChannelId: string,
      text: string,
      staleItems: number,
    ): Promise<string | null> => {
      try {
        const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || !ws.isActive) return null;
        const client = new WebClient(cipher.decrypt(ws.botTokenEncrypted));
        const res = await client.chat.postMessage({
          channel: slackChannelId,
          text: "Review queue digest",
          blocks: digestBlocks(text, staleItems),
        });
        return (res.ts as string | undefined) ?? null;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`digest post failed ws=${workspaceId} channel=${slackChannelId}`, err);
        return null;
      }
    };

    digestWorker = createDigestWorker({
      connection,
      store,
      model: digestModel,
      enqueueChannel: (ref) => digestQueue!.enqueueChannel(ref),
      postDigest,
    });
    digestWorker.on("failed", (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`digest job ${job?.id} failed`, err);
    });

    await digestQueue.scheduleSweep(process.env.DIGEST_CRON ?? "0 14 * * 1");
  }

  const shutdown = async () => {
    await worker.close();
    if (triageWorker) await triageWorker.close();
    if (digestWorker) await digestWorker.close();
    if (digestQueue) await digestQueue.close();
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // eslint-disable-next-line no-console
  console.log(
    `⚙️  worker listening on "${NOTIFICATION_QUEUE_NAME}"` +
      `${triageWorker ? ` + "${TRIAGE_QUEUE_NAME}"` : ""}` +
      `${digestWorker ? ` + "${DIGEST_QUEUE_NAME}"` : ""}`,
  );
}

// Only boot the worker when executed as a process, not when imported by a test.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Fatal worker startup error", err);
    process.exit(1);
  });
}
