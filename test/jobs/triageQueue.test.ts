// Pure unit tests for the triage-jobs handler. No Redis, no BullMQ, no SDK — a
// fake model, a fake store, and a stub loader stand in for the resolved
// collaborators. The durable transport (real Queue/Worker) and the Prisma store
// are covered by the env-gated integration tests.

import {
  runTriageJob,
  type TriageItem,
  type TriageItemJob,
  type TriageStore,
} from "../../src/jobs/triageQueue";
import type { RawTriage, TriageModel } from "../../src/services/triage";
import { SUMMARIZE_MIN_CHARS } from "../../src/services/triage";

class FakeTriageModel implements TriageModel {
  constructor(private readonly result: RawTriage) {}
  async classify(): Promise<RawTriage> {
    return this.result;
  }
}

class FakeTriageStore implements TriageStore {
  public summaries: Array<{ itemId: string; summary: string; model: string }> = [];
  public clarifications: Array<{ itemId: string; question: string; model: string }> = [];
  async saveSummary(itemId: string, summary: string, model: string): Promise<void> {
    this.summaries.push({ itemId, summary, model });
  }
  async saveClarification(itemId: string, question: string, model: string): Promise<void> {
    this.clarifications.push({ itemId, question, model });
  }
}

const JOB: TriageItemJob = { type: "triage-item", workspaceId: "ws_1", itemId: "item_1" };

function makeItem(overrides: Partial<TriageItem> = {}): TriageItem {
  return {
    id: "item_1",
    workspaceId: "ws_1",
    messageText: "x".repeat(SUMMARIZE_MIN_CHARS),
    permalink: "https://slack.example/p1",
    flaggedBySlackId: "U_FLAG",
    ...overrides,
  };
}

describe("runTriageJob", () => {
  it("is a no-op when the item no longer exists", async () => {
    const store = new FakeTriageStore();
    await runTriageJob(JOB, {
      loadItem: async () => null,
      model: new FakeTriageModel({ summary: "s", isVague: true, clarifyingQuestion: "q?" }),
      modelName: "claude-test",
      store,
    });
    expect(store.summaries).toHaveLength(0);
    expect(store.clarifications).toHaveLength(0);
  });

  it("persists a summary with the model provenance", async () => {
    const store = new FakeTriageStore();
    await runTriageJob(JOB, {
      loadItem: async () => makeItem(),
      model: new FakeTriageModel({ summary: "A summary.", isVague: false, clarifyingQuestion: null }),
      modelName: "claude-haiku-4-5",
      store,
    });
    expect(store.summaries).toEqual([{ itemId: "item_1", summary: "A summary.", model: "claude-haiku-4-5" }]);
    expect(store.clarifications).toHaveLength(0);
  });

  it("persists a clarification and asks the flagger when vague", async () => {
    const store = new FakeTriageStore();
    const asked: Array<{ item: TriageItem; question: string }> = [];
    await runTriageJob(JOB, {
      loadItem: async () => makeItem(),
      model: new FakeTriageModel({ summary: null, isVague: true, clarifyingQuestion: "Which contract?" }),
      modelName: "claude-test",
      store,
      askClarification: async (item, question) => {
        asked.push({ item, question });
      },
    });
    expect(store.clarifications).toEqual([{ itemId: "item_1", question: "Which contract?", model: "claude-test" }]);
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toBe("Which contract?");
  });

  it("does not ask when there is no flagger slack id", async () => {
    const store = new FakeTriageStore();
    const asked: string[] = [];
    await runTriageJob(JOB, {
      loadItem: async () => makeItem({ flaggedBySlackId: null }),
      model: new FakeTriageModel({ summary: null, isVague: true, clarifyingQuestion: "Which one?" }),
      modelName: "claude-test",
      store,
      askClarification: async (_item, question) => {
        asked.push(question);
      },
    });
    expect(store.clarifications).toHaveLength(1); // still persisted
    expect(asked).toHaveLength(0); // but nobody to DM
  });

  it("persists nothing for a trivially short item (model never consulted)", async () => {
    const store = new FakeTriageStore();
    let classified = false;
    await runTriageJob(JOB, {
      loadItem: async () => makeItem({ messageText: "hi" }),
      model: {
        async classify() {
          classified = true;
          return { summary: "s", isVague: true, clarifyingQuestion: "q?" };
        },
      },
      modelName: "claude-test",
      store,
    });
    expect(classified).toBe(false);
    expect(store.summaries).toHaveLength(0);
    expect(store.clarifications).toHaveLength(0);
  });
});
