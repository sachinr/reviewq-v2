// Unit tests for the triage core (services/triage.ts). The TriageModel is a fake
// so these run with no SDK/network: they pin the *rules* — when we skip the model
// entirely, and how we normalize what it returns.

import {
  MIN_TRIAGE_CHARS,
  SUMMARIZE_MIN_CHARS,
  MAX_SUMMARY_CHARS,
  runItemTriage,
  type RawTriage,
  type TriageModel,
} from "../../src/services/triage";

/** A TriageModel that records its calls and returns a scripted RawTriage. */
class FakeTriageModel implements TriageModel {
  public calls: Array<{ workspaceId: string; text: string }> = [];
  constructor(private readonly result: RawTriage) {}
  async classify(workspaceId: string, content: { text: string }): Promise<RawTriage> {
    this.calls.push({ workspaceId, text: content.text });
    return this.result;
  }
}

const clear: RawTriage = { summary: null, isVague: false, clarifyingQuestion: null };

function longText(chars: number): string {
  return "x".repeat(chars);
}

describe("runItemTriage", () => {
  it("skips trivial content without calling the model", async () => {
    const model = new FakeTriageModel(clear);
    const out = await runItemTriage({ itemText: "ship it" }, model, "ws_1");
    expect(out).toEqual({ skipped: true, summary: null, clarification: null });
    expect(model.calls).toHaveLength(0);
  });

  it("skips null/empty content", async () => {
    const model = new FakeTriageModel(clear);
    expect((await runItemTriage({ itemText: null }, model, "ws_1")).skipped).toBe(true);
    expect((await runItemTriage({ itemText: "   " }, model, "ws_1")).skipped).toBe(true);
    expect(model.calls).toHaveLength(0);
  });

  it("passes the workspace id and trimmed text through to the model", async () => {
    const model = new FakeTriageModel(clear);
    const text = `  ${longText(MIN_TRIAGE_CHARS)}  `;
    await runItemTriage({ itemText: text }, model, "ws_42");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].workspaceId).toBe("ws_42");
    expect(model.calls[0].text).toBe(longText(MIN_TRIAGE_CHARS)); // trimmed
  });

  it("keeps a summary only for sufficiently long items", async () => {
    const summary = "A concise one-line summary.";
    const model = new FakeTriageModel({ summary, isVague: false, clarifyingQuestion: null });

    // Long enough to summarize.
    const long = await runItemTriage({ itemText: longText(SUMMARIZE_MIN_CHARS) }, model, "ws_1");
    expect(long.summary).toBe(summary);

    // Triageable (>= MIN) but below the summarize threshold: no summary stored.
    const short = await runItemTriage({ itemText: longText(MIN_TRIAGE_CHARS + 1) }, model, "ws_1");
    expect(short.summary).toBeNull();
  });

  it("drops a summary that just echoes the original text", async () => {
    const text = longText(SUMMARIZE_MIN_CHARS);
    const model = new FakeTriageModel({ summary: text, isVague: false, clarifyingQuestion: null });
    const out = await runItemTriage({ itemText: text }, model, "ws_1");
    expect(out.summary).toBeNull();
  });

  it("clamps an over-long summary", async () => {
    const summary = "S".repeat(MAX_SUMMARY_CHARS + 50);
    const model = new FakeTriageModel({ summary, isVague: false, clarifyingQuestion: null });
    const out = await runItemTriage({ itemText: longText(SUMMARIZE_MIN_CHARS) }, model, "ws_1");
    expect(out.summary).not.toBeNull();
    expect(out.summary!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(out.summary!.endsWith("…")).toBe(true);
  });

  it("surfaces a clarifying question when the model flags the item vague", async () => {
    const model = new FakeTriageModel({
      summary: null,
      isVague: true,
      clarifyingQuestion: "Which document needs review?",
    });
    const out = await runItemTriage({ itemText: longText(MIN_TRIAGE_CHARS) }, model, "ws_1");
    expect(out.skipped).toBe(false);
    expect(out.clarification).toBe("Which document needs review?");
  });

  it("treats vague-with-no-question as clear (no clarification)", async () => {
    const model = new FakeTriageModel({ summary: null, isVague: true, clarifyingQuestion: "   " });
    const out = await runItemTriage({ itemText: longText(MIN_TRIAGE_CHARS) }, model, "ws_1");
    expect(out.clarification).toBeNull();
  });

  it("ignores a clarifying question when the item is not vague", async () => {
    const model = new FakeTriageModel({
      summary: null,
      isVague: false,
      clarifyingQuestion: "leftover question",
    });
    const out = await runItemTriage({ itemText: longText(MIN_TRIAGE_CHARS) }, model, "ws_1");
    expect(out.clarification).toBeNull();
  });
});
