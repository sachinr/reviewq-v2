import {
  createAnthropicResponder,
  defaultSystemPrompt,
  FALLBACK_REPLY,
  type AnthropicChat,
  type ChatMessage,
} from "../../src/services/anthropicResponder";
import {
  createAssistantService,
  type Responder,
  type TurnView,
} from "../../src/services/assistantService";
import { pumpStream, type StreamSink } from "../../src/slack/streamBridge";

/**
 * A fake AnthropicChat: records what the responder asked for and replays a
 * scripted sequence of text deltas (one `stream()` "chunk" per array element),
 * so we exercise the streaming path without the SDK or a network call.
 */
function fakeChat(deltas: string[]) {
  const calls: { system: string; messages: ChatMessage[] }[] = [];
  const chat: AnthropicChat = {
    async *stream(system, messages) {
      calls.push({ system, messages });
      for (const d of deltas) yield d;
    },
  };
  return { chat, calls };
}

describe("anthropicResponder", () => {
  it("concatenates the streamed deltas into the final reply", async () => {
    const { chat } = fakeChat(["Hello", ", ", "world"]);
    const r = createAnthropicResponder({ chat });

    const reply = await r.reply([{ role: "user", content: "hi" }], "hi");

    expect(reply).toBe("Hello, world");
  });

  it("trims surrounding whitespace from the model's output", async () => {
    const { chat } = fakeChat(["  spaced reply\n"]);
    const r = createAnthropicResponder({ chat });

    expect(await r.reply([{ role: "user", content: "hi" }], "hi")).toBe("spaced reply");
  });

  it("falls back to a safe message when the model returns nothing usable", async () => {
    const { chat } = fakeChat(["  ", "\n"]);
    const r = createAnthropicResponder({ chat });

    expect(await r.reply([{ role: "user", content: "hi" }], "hi")).toBe(FALLBACK_REPLY);
  });

  it("sends the full history as messages and a system prompt naming the app", async () => {
    const { chat, calls } = fakeChat(["ok"]);
    const r = createAnthropicResponder({ chat, appName: "Reviewed" });

    const history: TurnView[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ];
    await r.reply(history, "second");

    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
    // History already ends with the latest user turn — it must not be duplicated.
    expect(calls[0].messages.filter((m) => m.content === "second")).toHaveLength(1);
    expect(calls[0].system).toContain("Reviewed");
  });

  it("falls back to `latest` only when history arrives empty", async () => {
    const { chat, calls } = fakeChat(["ok"]);
    const r = createAnthropicResponder({ chat });

    await r.reply([], "just this");

    expect(calls[0].messages).toEqual([{ role: "user", content: "just this" }]);
  });

  it("honors an overridden system prompt", async () => {
    const { chat, calls } = fakeChat(["ok"]);
    const r = createAnthropicResponder({ chat, systemPrompt: "custom" });

    await r.reply([{ role: "user", content: "hi" }], "hi");

    expect(calls[0].system).toBe("custom");
  });

  it("streams tokens through streamBridge in rate-respecting batches", async () => {
    // Long, LLM-shaped output split into many small deltas — exactly the case
    // streamBridge exists to batch before hitting Slack's append endpoint.
    const words = Array.from({ length: 60 }, (_, i) => `word${i} `);
    const { chat } = fakeChat(words);
    const r = createAnthropicResponder({ chat });

    const appended: string[] = [];
    const sink: StreamSink = {
      async append(text) {
        appended.push(text);
      },
    };

    const result = await pumpStream(r.replyStream([{ role: "user", content: "go" }], "go"), sink, {
      batchChars: 100,
    });

    const full = words.join("");
    expect(appended.join("")).toBe(full); // nothing dropped in batching
    expect(result.totalChars).toBe(full.length);
    // Batched, not token-by-token: far fewer appends than deltas.
    expect(result.appendCalls).toBeLessThan(words.length);
  });

  it("drops into assistantService as a Responder with no other changes", async () => {
    // Proves the port contract: the Anthropic responder is interchangeable with
    // the canned one from the service's point of view.
    const { chat } = fakeChat(["queued reply"]);
    const responder: Responder = createAnthropicResponder({ chat });

    const messages: { role: string; content: string }[] = [];
    const store = {
      async getOrCreateThread() {
        return { id: "t1" } as never;
      },
      async setContextChannel() {},
      async addMessage(_t: string, role: "user" | "assistant", content: string) {
        messages.push({ role, content });
        return { role, content } as never;
      },
      async getMessages() {
        return messages.map((m) => ({ ...m })) as never;
      },
      async touch() {},
    };
    const svc = createAssistantService({ store, responder });

    const { reply } = await svc.handleUserMessage(
      { workspaceId: "w", appUserId: "u", slackChannelId: "D1", slackThreadTs: "1.1" },
      "help",
      new Date("2026-07-05T00:00:00Z"),
    );

    expect(reply).toBe("queued reply");
    expect(messages).toEqual([
      { role: "user", content: "help" },
      { role: "assistant", content: "queued reply" },
    ]);
  });

  it("defaultSystemPrompt describes the core review-queue actions", () => {
    const p = defaultSystemPrompt("Reviewed");
    expect(p).toContain("Reviewed");
    expect(p).toContain("Add to review queue");
    expect(p.toLowerCase()).toContain("slash command");
  });
});
