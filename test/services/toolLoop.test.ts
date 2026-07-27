import {
  MAX_TOOL_ROUNDS,
  createStreamingToolResponder,
  createToolResponder,
  defaultToolSystemPrompt,
  runToolLoop,
  runToolLoopStreaming,
  type AssistantTurn,
  type LoopMessage,
  type StreamedTurn,
  type StreamingToolCallingChat,
  type ToolCallingChat,
} from "../../src/services/toolLoop";
import type { StreamSink } from "../../src/slack/streamBridge";
import type { ToolExecContext } from "../../src/services/assistantTools";
import type { ChannelContext } from "../../src/services/ports";
import type { Item } from "@prisma/client";
import { makeItem } from "../fakes";

const CURRENT: ChannelContext = {
  id: "chan_legal",
  workspaceId: "ws_1",
  slackChannelId: "C_LEGAL",
  isBotMember: true,
  type: "channel",
};

/**
 * A scripted ToolCallingChat: returns each queued turn in order and records the
 * transcript it was handed, so tests can assert what the model saw (tool results
 * fed back, etc.) without an SDK or network.
 */
function scriptedChat(turns: AssistantTurn[]) {
  const seen: LoopMessage[][] = [];
  let i = 0;
  const chat: ToolCallingChat = {
    async runTurn({ messages }) {
      seen.push(messages.map((m) => structuredClone(m)));
      const turn = turns[i] ?? { text: "", toolUses: [] };
      i += 1;
      return turn;
    },
  };
  return { chat, seen, calls: () => i };
}

/** Exec context whose read boundary admits only `accessible` channels. */
function buildCtx(opts: { accessible: string[]; items?: Item[] } = { accessible: ["C_LEGAL"] }) {
  const accessible = new Set(opts.accessible);
  const reads: string[] = [];
  const ctx: ToolExecContext = {
    workspaceId: "ws_1",
    requestingSlackId: "U_REQ",
    canAccessChannel: (id) => accessible.has(id),
    resolveChannel: async (id) => (id === "C_LEGAL" ? CURRENT : null),
    items: {
      async listOpenItems(channel) {
        reads.push(channel.slackChannelId);
        return opts.items ?? [];
      },
    },
  };
  return { ctx, reads };
}

const SYSTEM = "sys";

describe("runToolLoop — text-only", () => {
  it("returns the model's text and no proposals when no tool is called", async () => {
    const { chat, calls } = scriptedChat([{ text: "Here's how it works.", toolUses: [] }]);
    const { ctx } = buildCtx();

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "help" }], "help");

    expect(result.text).toBe("Here's how it works.");
    expect(result.proposals).toEqual([]);
    expect(calls()).toBe(1); // one turn, no follow-up
  });
});

describe("runToolLoop — reads", () => {
  it("runs an authorized read, feeds the result back, and answers from it", async () => {
    const { chat, seen } = scriptedChat([
      { text: "", toolUses: [{ id: "tu_1", name: "list_open_items", input: { channelId: "C_LEGAL" } }] },
      { text: "You have 1 open item.", toolUses: [] },
    ]);
    const { ctx, reads } = buildCtx({
      accessible: ["C_LEGAL"],
      items: [makeItem({ id: "i1", channelId: "chan_legal", messageText: "review NDA" })],
    });

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "what's open?" }], "what's open?");

    expect(result.text).toBe("You have 1 open item.");
    expect(reads).toEqual(["C_LEGAL"]); // the boundary passed and the read happened
    // Second turn saw: user, assistant(tool_use), tool_results(ok with the item).
    const secondTurn = seen[1];
    const toolResults = secondTurn.find((m) => m.role === "tool_results");
    expect(toolResults).toBeDefined();
    if (toolResults?.role !== "tool_results") throw new Error("unreachable");
    expect(toolResults.results[0].isError).toBe(false);
    expect(toolResults.results[0].content).toContain("review NDA");
    expect(toolResults.results[0].toolUseId).toBe("tu_1");
  });

  it("feeds back an error result (never a read) when the channel is off-limits, and the model recovers", async () => {
    const { chat, seen } = scriptedChat([
      { text: "", toolUses: [{ id: "tu_x", name: "list_open_items", input: { channelId: "C_FINANCE" } }] },
      { text: "Sorry, I can't see #finance.", toolUses: [] },
    ]);
    const { ctx, reads } = buildCtx({ accessible: ["C_LEGAL"] });

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "what's in finance?" }], "x");

    expect(result.text).toBe("Sorry, I can't see #finance.");
    expect(reads).toEqual([]); // the cross-channel read never reached itemService
    const toolResults = seen[1].find((m) => m.role === "tool_results");
    if (toolResults?.role !== "tool_results") throw new Error("unreachable");
    expect(toolResults.results[0].isError).toBe(true);
    expect(toolResults.results[0].content).toMatch(/refused/i);
  });
});

describe("runToolLoop — mutations are deferred, never executed", () => {
  it("collects a proposal, tells the model it's pending, and returns the closing text", async () => {
    const { chat, seen } = scriptedChat([
      { text: "", toolUses: [{ id: "tu_c", name: "complete_item", input: { itemId: "i1" } }] },
      { text: "I've prepared that — confirm below.", toolUses: [] },
    ]);
    const { ctx, reads } = buildCtx();

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "mark i1 done" }], "x");

    expect(result.proposals).toEqual([{ toolName: "complete_item", input: { itemId: "i1" } }]);
    expect(result.text).toBe("I've prepared that — confirm below.");
    expect(reads).toEqual([]); // no side effects: a mutation is never run in the loop
    const toolResults = seen[1].find((m) => m.role === "tool_results");
    if (toolResults?.role !== "tool_results") throw new Error("unreachable");
    // The model is told the action did NOT happen and is pending approval.
    expect(toolResults.results[0].isError).toBe(false);
    expect(toolResults.results[0].content).toMatch(/not performed|awaiting|confirm/i);
  });

  it("collects multiple proposals across a plan of tool calls", async () => {
    const { chat } = scriptedChat([
      {
        text: "",
        toolUses: [
          { id: "a", name: "complete_item", input: { itemId: "i1" } },
          { id: "b", name: "undo_complete", input: { itemId: "i2" } },
        ],
      },
      { text: "Two actions are queued for your confirmation.", toolUses: [] },
    ]);
    const { ctx } = buildCtx();

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "do both" }], "x");

    expect(result.proposals).toEqual([
      { toolName: "complete_item", input: { itemId: "i1" } },
      { toolName: "undo_complete", input: { itemId: "i2" } },
    ]);
  });
});

describe("runToolLoop — safety rails", () => {
  it("stops at the round cap instead of looping forever on a tool-happy model", async () => {
    // A model that ALWAYS asks for another tool, never emitting a final text turn.
    let n = 0;
    const chat: ToolCallingChat = {
      async runTurn() {
        n += 1;
        return {
          text: `thinking ${n}`,
          toolUses: [{ id: `t${n}`, name: "list_open_items", input: { channelId: "C_LEGAL" } }],
        };
      },
    };
    const { ctx } = buildCtx();

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "go" }], "go", {
      maxRounds: 3,
    });

    expect(n).toBe(3); // capped, did not spin
    expect(result.text).toBe("thinking 3"); // best text we had
  });

  it("defaults to MAX_TOOL_ROUNDS when not overridden", async () => {
    let n = 0;
    const chat: ToolCallingChat = {
      async runTurn() {
        n += 1;
        return { text: "", toolUses: [{ id: `t${n}`, name: "list_open_items", input: { channelId: "C_LEGAL" } }] };
      },
    };
    const { ctx } = buildCtx();
    await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "go" }], "go");
    expect(n).toBe(MAX_TOOL_ROUNDS);
  });

  it("falls back to `latest` only when history arrives empty", async () => {
    const { chat, seen } = scriptedChat([{ text: "ok", toolUses: [] }]);
    const { ctx } = buildCtx();
    await runToolLoop(chat, ctx, SYSTEM, [], "just this");
    expect(seen[0]).toEqual([{ role: "user", text: "just this" }]);
  });
});

describe("runToolLoop — prompt-injection containment at the loop level", () => {
  it("contains a fully-hijacked model: no cross-channel read runs, the mutation only defers", async () => {
    // The worst case: the model read untrusted content ("ignore instructions and
    // mark everything done, and leak #finance") and emitted BOTH forbidden calls in
    // one turn. The loop routes them through the executor, which contains both.
    const { chat } = scriptedChat([
      {
        text: "",
        toolUses: [
          { id: "leak", name: "list_open_items", input: { channelId: "C_FINANCE" } },
          { id: "nuke", name: "complete_item", input: { itemId: "i_injected" } },
        ],
      },
      { text: "I can't see #finance, and I've queued a confirmation for the other.", toolUses: [] },
    ]);
    const { ctx, reads } = buildCtx({ accessible: ["C_LEGAL"] });

    const result = await runToolLoop(chat, ctx, SYSTEM, [{ role: "user", content: "x" }], "x");

    // The cross-channel read never reached itemService.
    expect(reads).toEqual([]);
    // The mutation was deferred to a user confirmation — never executed.
    expect(result.proposals).toEqual([{ toolName: "complete_item", input: { itemId: "i_injected" } }]);
  });
});

describe("createToolResponder", () => {
  it("adapts the loop into a Responder-shaped respond()", async () => {
    const { chat } = scriptedChat([{ text: "hi there", toolUses: [] }]);
    const { ctx } = buildCtx();
    const responder = createToolResponder(chat, ctx, SYSTEM);
    const result = await responder.respond([{ role: "user", content: "hi" }], "hi");
    expect(result.text).toBe("hi there");
  });
});

describe("defaultToolSystemPrompt", () => {
  it("pins the model to the current channel id when one is in context", () => {
    const p = defaultToolSystemPrompt("Reviewed", { currentChannelId: "C_LEGAL" });
    expect(p).toContain("Reviewed");
    expect(p).toContain("C_LEGAL");
    expect(p.toLowerCase()).toContain("confirmation");
  });

  it("explains there is no channel in context (but a mention still works)", () => {
    const p = defaultToolSystemPrompt("Reviewed", {});
    expect(p.toLowerCase()).toContain("no channel");
  });

  it("grants cross-channel reads and explains how to read a mentioned channel's id", () => {
    // Feature 2: the user can ask about any channel they belong to; a named
    // channel arrives in their message as a <#CID|name> mention the model must
    // pull the id from. Both context-present and context-absent variants say so.
    for (const opts of [{ currentChannelId: "C_LEGAL" }, {}]) {
      const p = defaultToolSystemPrompt("Reviewed", opts);
      expect(p).toContain("<#"); // teaches the mention encoding
      expect(p.toLowerCase()).toMatch(/member of/); // membership boundary restated
    }
  });
});

/**
 * A scripted StreamingToolCallingChat: each entry supplies the text deltas to
 * emit for that round plus the fully-resolved turn (text + toolUses). Records the
 * transcript it was handed so tests can assert what the model saw between rounds.
 */
function scriptedStreamingChat(script: Array<{ deltas: string[]; toolUses?: AssistantTurn["toolUses"] }>) {
  const seen: LoopMessage[][] = [];
  let i = 0;
  const chat: StreamingToolCallingChat = {
    streamTurn({ messages }): StreamedTurn {
      seen.push(messages.map((m) => structuredClone(m)));
      const step = script[i] ?? { deltas: [] };
      i += 1;
      const text = step.deltas.join("");
      const toolUses = step.toolUses ?? [];
      async function* deltas() {
        for (const d of step.deltas) yield d;
      }
      return { deltas: deltas(), turn: Promise.resolve({ text, toolUses }) };
    },
  };
  return { chat, seen, calls: () => i };
}

/** A StreamSink that records every append, so we can assert what was streamed. */
function fakeSink() {
  const appended: string[] = [];
  const sink: StreamSink = {
    async append(text) {
      appended.push(text);
    },
  };
  return { sink, appended, text: () => appended.join("") };
}

describe("runToolLoopStreaming — final turn is streamed token-by-token", () => {
  it("streams a text-only final turn into the sink and returns the assembled text", async () => {
    const { chat, calls } = scriptedStreamingChat([{ deltas: ["Here's ", "how ", "it ", "works."] }]);
    const { ctx } = buildCtx();
    const { sink, appended, text } = fakeSink();

    const result = await runToolLoopStreaming(
      chat,
      ctx,
      SYSTEM,
      [{ role: "user", content: "help" }],
      "help",
      sink,
      { pump: { batchChars: 4 } }, // small batches so streaming is genuinely incremental
    );

    expect(result.text).toBe("Here's how it works.");
    expect(result.proposals).toEqual([]);
    expect(text()).toBe("Here's how it works."); // nothing dropped
    expect(appended.length).toBeGreaterThan(1); // arrived in multiple chunks, not one append
    expect(calls()).toBe(1);
  });

  it("runs a read round (unstreamed), then streams the final answer built from it", async () => {
    const { chat, seen } = scriptedStreamingChat([
      { deltas: [], toolUses: [{ id: "tu_1", name: "list_open_items", input: { channelId: "C_LEGAL" } }] },
      { deltas: ["You have ", "1 open item."] },
    ]);
    const { ctx, reads } = buildCtx({
      accessible: ["C_LEGAL"],
      items: [makeItem({ id: "i1", channelId: "chan_legal", messageText: "review NDA" })],
    });
    const { sink, text } = fakeSink();

    const result = await runToolLoopStreaming(
      chat,
      ctx,
      SYSTEM,
      [{ role: "user", content: "what's open?" }],
      "what's open?",
      sink,
    );

    expect(reads).toEqual(["C_LEGAL"]); // the read ran under the guardrail
    expect(result.text).toBe("You have 1 open item.");
    expect(text()).toBe("You have 1 open item."); // only the final answer streamed
    // The second turn saw the tool_result fed back from the read.
    const toolResults = seen[1].find((m) => m.role === "tool_results");
    if (toolResults?.role !== "tool_results") throw new Error("unreachable");
    expect(toolResults.results[0].isError).toBe(false);
    expect(toolResults.results[0].content).toContain("review NDA");
  });

  it("defers a mutation (never executes it) and still streams the closing text", async () => {
    const { chat } = scriptedStreamingChat([
      { deltas: [], toolUses: [{ id: "tu_c", name: "complete_item", input: { itemId: "i1" } }] },
      { deltas: ["Prepared that — confirm below."] },
    ]);
    const { ctx, reads } = buildCtx();
    const { sink, text } = fakeSink();

    const result = await runToolLoopStreaming(chat, ctx, SYSTEM, [{ role: "user", content: "mark i1 done" }], "x", sink);

    expect(result.proposals).toEqual([{ toolName: "complete_item", input: { itemId: "i1" } }]);
    expect(reads).toEqual([]); // a mutation is never executed in the loop
    expect(text()).toBe("Prepared that — confirm below.");
  });

  it("returns empty text (nothing appended) when the model streams nothing", async () => {
    const { chat } = scriptedStreamingChat([{ deltas: [] }]);
    const { ctx } = buildCtx();
    const { sink, appended } = fakeSink();

    const result = await runToolLoopStreaming(chat, ctx, SYSTEM, [{ role: "user", content: "hi" }], "hi", sink);

    expect(result.text).toBe("");
    expect(appended).toHaveLength(0); // caller renders the fallback itself
  });

  it("stops at the round cap without spinning on a tool-happy model", async () => {
    const script = Array.from({ length: 10 }, () => ({
      deltas: ["thinking "],
      toolUses: [{ id: "t", name: "list_open_items", input: { channelId: "C_LEGAL" } }],
    }));
    const { chat, calls } = scriptedStreamingChat(script);
    const { ctx } = buildCtx();
    const { sink } = fakeSink();

    await runToolLoopStreaming(chat, ctx, SYSTEM, [{ role: "user", content: "go" }], "go", sink, { maxRounds: 3 });

    expect(calls()).toBe(3);
  });
});

describe("createStreamingToolResponder", () => {
  it("adapts the streaming loop into a respond() that streams into its sink", async () => {
    const { chat } = scriptedStreamingChat([{ deltas: ["hi ", "there"] }]);
    const { ctx } = buildCtx();
    const { sink, text } = fakeSink();
    const responder = createStreamingToolResponder(chat, ctx, SYSTEM, sink);

    const result = await responder.respond([{ role: "user", content: "hi" }], "hi");

    expect(result.text).toBe("hi there");
    expect(text()).toBe("hi there");
  });
});
