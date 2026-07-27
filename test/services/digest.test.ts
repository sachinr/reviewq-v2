import {
  computeStaleDigest,
  STALE_AFTER_MS,
  MAX_DIGEST_ITEMS,
  type DigestModel,
  type StaleItem,
} from "../../src/services/digest";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function staleItem(id: string, createdAt: Date, text = `item ${id}`): StaleItem {
  return { id, messageText: text, permalink: `https://slack/${id}`, createdAt };
}

/** Records the items it was asked to summarize; returns a scripted digest. */
class FakeDigestModel implements DigestModel {
  public calls: { workspaceId: string; items: StaleItem[] }[] = [];
  constructor(private reply: string = "3 items have been waiting over a week.") {}
  async summarize(workspaceId: string, items: StaleItem[]): Promise<string> {
    this.calls.push({ workspaceId, items });
    return this.reply;
  }
}

describe("computeStaleDigest", () => {
  it("produces no digest and makes no model call when nothing is stale", async () => {
    const model = new FakeDigestModel();
    const items = [staleItem("a", daysAgo(1)), staleItem("b", daysAgo(3))];

    const out = await computeStaleDigest(items, NOW, model, "ws_1");

    expect(out.hasDigest).toBe(false);
    expect(out.staleItems).toBe(0);
    expect(out.itemsConsidered).toBe(2);
    expect(out.summaryText).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it("summarizes only the stale items (oldest first) and counts considered vs stale", async () => {
    const model = new FakeDigestModel("Two contracts are stuck.");
    const items = [
      staleItem("fresh", daysAgo(2)),
      staleItem("old", daysAgo(10)),
      staleItem("older", daysAgo(20)),
    ];

    const out = await computeStaleDigest(items, NOW, model, "ws_1");

    expect(out.hasDigest).toBe(true);
    expect(out.itemsConsidered).toBe(3);
    expect(out.staleItems).toBe(2);
    expect(out.summaryText).toBe("Two contracts are stuck.");
    // model saw only the two stale items, oldest first, scoped to the workspace
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].workspaceId).toBe("ws_1");
    expect(model.calls[0].items.map((i) => i.id)).toEqual(["older", "old"]);
  });

  it("treats an item exactly at the staleness threshold as stale", async () => {
    const model = new FakeDigestModel();
    const atThreshold = new Date(NOW.getTime() - STALE_AFTER_MS);
    const out = await computeStaleDigest([staleItem("edge", atThreshold)], NOW, model, "ws_1");

    expect(out.staleItems).toBe(1);
    expect(out.hasDigest).toBe(true);
  });

  it("caps the number of items sent to the model but still counts them all", async () => {
    const model = new FakeDigestModel();
    const many = Array.from({ length: MAX_DIGEST_ITEMS + 5 }, (_, i) =>
      staleItem(`s${String(i).padStart(2, "0")}`, daysAgo(10 + i)),
    );

    const out = await computeStaleDigest(many, NOW, model, "ws_1");

    expect(out.staleItems).toBe(MAX_DIGEST_ITEMS + 5);
    expect(model.calls[0].items).toHaveLength(MAX_DIGEST_ITEMS);
  });

  it("suppresses the digest when the model returns only whitespace (no empty post)", async () => {
    const model = new FakeDigestModel("   \n  ");
    const out = await computeStaleDigest([staleItem("old", daysAgo(10))], NOW, model, "ws_1");

    expect(out.staleItems).toBe(1);
    expect(out.hasDigest).toBe(false);
    expect(out.summaryText).toBeNull();
  });
});
