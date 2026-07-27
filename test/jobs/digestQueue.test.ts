import {
  runChannelDigestJob,
  type ChannelDigestJob,
  type DigestJobDeps,
  type RecordedDigestRun,
} from "../../src/jobs/digestQueue";
import type { DigestModel, StaleItem } from "../../src/services/digest";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const job: ChannelDigestJob = {
  type: "channel-digest",
  workspaceId: "ws_1",
  channelId: "chan_1",
  slackChannelId: "C_LEGAL",
};

class FakeDigestModel implements DigestModel {
  public calls: string[] = [];
  constructor(private reply = "Two items are stuck.") {}
  async summarize(workspaceId: string): Promise<string> {
    this.calls.push(workspaceId);
    return this.reply;
  }
}

function deps(overrides: Partial<DigestJobDeps> = {}): {
  deps: DigestJobDeps;
  posted: { channel: string; text: string }[];
  runs: RecordedDigestRun[];
  model: FakeDigestModel;
} {
  const posted: { channel: string; text: string }[] = [];
  const runs: RecordedDigestRun[] = [];
  const model = new FakeDigestModel();
  const base: DigestJobDeps = {
    loadOpenItems: async () => [],
    model,
    clock: () => NOW,
    post: async (channel, text) => {
      posted.push({ channel, text });
      return "1700000000.000200";
    },
    recordRun: async (run) => void runs.push(run),
    ...overrides,
  };
  return { deps: base, posted, runs, model };
}

function items(...its: StaleItem[]): () => Promise<StaleItem[]> {
  return async () => its;
}
const stale = (id: string, ageDays: number): StaleItem => ({
  id,
  messageText: `item ${id}`,
  permalink: null,
  createdAt: daysAgo(ageDays),
});

describe("runChannelDigestJob", () => {
  it("posts the digest and records a run with the posted ts when items are stale", async () => {
    const { deps: d, posted, runs, model } = deps({ loadOpenItems: items(stale("a", 10), stale("b", 2)) });

    await runChannelDigestJob(job, d);

    expect(model.calls).toEqual(["ws_1"]); // workspace-scoped model call
    expect(posted).toEqual([{ channel: "C_LEGAL", text: "Two items are stuck." }]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: "chan_1",
      itemsConsidered: 2,
      staleItems: 1,
      summaryText: "Two items are stuck.",
      postedMessageTs: "1700000000.000200",
    });
  });

  it("records an empty run and posts nothing when no item is stale", async () => {
    const { deps: d, posted, runs, model } = deps({ loadOpenItems: items(stale("a", 1), stale("b", 3)) });

    await runChannelDigestJob(job, d);

    expect(model.calls).toHaveLength(0); // no model call when nothing stale
    expect(posted).toHaveLength(0);
    expect(runs[0]).toMatchObject({ itemsConsidered: 2, staleItems: 0, summaryText: null, postedMessageTs: null });
  });

  it("records the digest with a null posted ts when the post fails", async () => {
    const { deps: d, runs } = deps({
      loadOpenItems: items(stale("a", 10)),
      post: async () => null,
    });

    await runChannelDigestJob(job, d);

    expect(runs[0]).toMatchObject({
      staleItems: 1,
      summaryText: "Two items are stuck.",
      postedMessageTs: null,
    });
  });
});
