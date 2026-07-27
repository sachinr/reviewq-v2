// triage-jobs — the background transport for AI triage. Slack's 3-second ack
// window can never include a live LLM call, so the add path enqueues one of these
// per newly-created item and returns immediately; the worker runs the model pass
// and persists the results. This module is the pure core: the queue name, the job
// payload, the collaborator ports, and a handler that performs one job given
// already-resolved collaborators. It imports neither BullMQ nor Redis nor the
// SDK, so `runTriageJob` is unit-tested against fakes; the BullMQ Queue/Worker and
// the Prisma/Anthropic adapters live next to it.

import { runItemTriage, type TriageModel } from "../services/triage";

/** BullMQ queue name. Shared by the producer (web) and the worker process. */
export const TRIAGE_QUEUE_NAME = "triage-jobs";

/**
 * Triage a single newly-added item. `workspaceId` is carried so the worker can
 * re-mint that workspace's Slack client (to ask a clarifying question) exactly as
 * the notification worker does; `itemId` is the internal Item id to triage.
 */
export interface TriageItemJob {
  type: "triage-item";
  workspaceId: string;
  itemId: string;
}

/** All triage-jobs payloads (room for future triage variants without plumbing changes). */
export type TriageJob = TriageItemJob;

/** The item fields triage needs, resolved from the DB by the worker. */
export interface TriageItem {
  id: string;
  workspaceId: string;
  messageText: string | null;
  permalink: string | null;
  /** Slack user id of whoever flagged the item — the recipient of any clarifying question. */
  flaggedBySlackId: string | null;
}

/** Persistence port for triage outputs (Prisma-backed in production). */
export interface TriageStore {
  saveSummary(itemId: string, summary: string, model: string): Promise<void>;
  saveClarification(itemId: string, question: string, model: string): Promise<void>;
}

export interface TriageJobDeps {
  /** Load the item to triage. Null when it was completed/deleted before the job ran. */
  loadItem(itemId: string): Promise<TriageItem | null>;
  /** The Claude-backed classifier. */
  model: TriageModel;
  /** The model id, stamped onto persisted rows for provenance/drift debugging. */
  modelName: string;
  /** Where summary/clarification rows are written. */
  store: TriageStore;
  /**
   * Optionally deliver the clarifying question to the flagger (a DM). Best-effort
   * and injected so the pure handler stays Slack-free; omitted in tests.
   */
  askClarification?(item: TriageItem, question: string): Promise<void>;
}

/**
 * Perform one triage job: load the item, run the model pass, and persist whatever
 * it produced. A missing item is a no-op (it was cleared before triage ran, which
 * is normal and must not error — an error would send BullMQ into pointless
 * retries). Any real failure (model/DB) propagates so BullMQ's backoff retries it.
 */
export async function runTriageJob(job: TriageJob, deps: TriageJobDeps): Promise<void> {
  const item = await deps.loadItem(job.itemId);
  if (!item) return;

  const outcome = await runItemTriage({ itemText: item.messageText }, deps.model, item.workspaceId);
  if (outcome.skipped) return;

  if (outcome.summary) {
    await deps.store.saveSummary(item.id, outcome.summary, deps.modelName);
  }
  if (outcome.clarification) {
    await deps.store.saveClarification(item.id, outcome.clarification, deps.modelName);
    if (deps.askClarification && item.flaggedBySlackId) {
      await deps.askClarification(item, outcome.clarification);
    }
  }
}
