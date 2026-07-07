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

  const config = loadConfig();
  const cipher = createTokenCipher(config.tokenEncryptionKey);
  const connection = createRedisConnection(config.redisUrl);

  const worker = createNotificationWorker({
    connection,
    async gatewayForWorkspace(workspaceId) {
      const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!ws || !ws.isActive) {
        // A job for an uninstalled workspace: don't retry forever against a dead
        // token — UnrecoverableError skips remaining attempts and fails the job.
        throw new UnrecoverableError(`workspace ${workspaceId} not found or inactive`);
      }
      return new SlackClient(new WebClient(cipher.decrypt(ws.botTokenEncrypted)));
    },
  });

  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`notification job ${job?.id} failed`, err);
  });

  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // eslint-disable-next-line no-console
  console.log(`⚙️  notificationWorker listening on "${NOTIFICATION_QUEUE_NAME}"`);
}

// Only boot the worker when executed as a process, not when imported by a test.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Fatal worker startup error", err);
    process.exit(1);
  });
}
