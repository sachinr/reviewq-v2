// triageWorker — the consumer side of triage-jobs. Runs in the same worker
// process as the notification worker (both booted by jobs/worker.ts) but on its
// own queue. Each job runs the LLM triage pass and persists the result; when the
// item was flagged as vague, it also DMs the flagger the clarifying question via
// a re-minted per-workspace bot client (the same pattern the notification worker
// uses). The factory takes its collaborators so it can be integration-tested
// against fakes + real Redis without a live Slack token or API key.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { SlackGateway } from "../services/ports";
import type { TriageModel } from "../services/triage";
import { bullConnection } from "./connection";
import {
  TRIAGE_QUEUE_NAME,
  runTriageJob,
  type TriageItem,
  type TriageJob,
  type TriageStore,
} from "./triageQueue";

export interface TriageWorkerDeps {
  connection: Redis;
  loadItem(itemId: string): Promise<TriageItem | null>;
  model: TriageModel;
  modelName: string;
  store: TriageStore;
  /**
   * Optional per-workspace Slack client resolver, used to DM the clarifying
   * question. Omit to persist clarifications without asking (e.g. in tests, or a
   * deployment that only surfaces them in-app).
   */
  gatewayForWorkspace?(workspaceId: string): Promise<SlackGateway>;
}

export function createTriageWorker(deps: TriageWorkerDeps): Worker<TriageJob> {
  const askClarification = deps.gatewayForWorkspace
    ? async (item: TriageItem, question: string): Promise<void> => {
        const slack = await deps.gatewayForWorkspace!(item.workspaceId);
        await slack.postMessage(item.flaggedBySlackId as string, clarificationDmText(item, question));
      }
    : undefined;

  return new Worker<TriageJob>(
    TRIAGE_QUEUE_NAME,
    async (job) => {
      await runTriageJob(job.data, {
        loadItem: deps.loadItem,
        model: deps.model,
        modelName: deps.modelName,
        store: deps.store,
        askClarification,
      });
    },
    { connection: bullConnection(deps.connection) },
  );
}

/** The DM asking the flagger to clarify an item triage judged too vague. */
export function clarificationDmText(item: TriageItem, question: string): string {
  const link = item.permalink ? `<${item.permalink}|the item you just added>` : "the item you just added";
  return `:speech_balloon: About ${link} — to make it easier to review: ${question}`;
}
