import type { AssistantMessage, AssistantThread } from "@prisma/client";
import {
  ASSISTANT_FALLBACK_REPLY,
  createAssistantService,
  createCannedResponder,
  type AssistantStore,
  type GetOrCreateThreadInput,
  type Responder,
  type TurnView,
} from "../../src/services/assistantService";
import type { StreamingResponder } from "../../src/services/anthropicResponder";
import type { StreamSink } from "../../src/slack/streamBridge";

const NOW = new Date("2026-07-05T12:00:00.000Z");

class FakeAssistantStore implements AssistantStore {
  threads = new Map<string, AssistantThread>();
  messages: AssistantMessage[] = [];
  private seq = 0;

  async getOrCreateThread(input: GetOrCreateThreadInput): Promise<AssistantThread> {
    const key = `${input.workspaceId}:${input.slackChannelId}:${input.slackThreadTs}`;
    const existing = [...this.threads.values()].find(
      (t) => `${t.workspaceId}:${t.slackChannelId}:${t.slackThreadTs}` === key,
    );
    if (existing) return existing;
    const thread: AssistantThread = {
      id: `thread_${++this.seq}`,
      workspaceId: input.workspaceId,
      appUserId: input.appUserId,
      slackChannelId: input.slackChannelId,
      slackThreadTs: input.slackThreadTs,
      contextChannelId: null,
      createdAt: NOW,
      lastActiveAt: NOW,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }
  async setContextChannel(threadId: string, contextChannelId: string | null): Promise<void> {
    const t = this.threads.get(threadId);
    if (t) this.threads.set(threadId, { ...t, contextChannelId });
  }
  async addMessage(threadId: string, role: "user" | "assistant", content: string): Promise<AssistantMessage> {
    const m: AssistantMessage = {
      id: `msg_${++this.seq}`,
      assistantThreadId: threadId,
      role,
      content,
      createdAt: NOW,
    };
    this.messages.push(m);
    return m;
  }
  async getMessages(threadId: string): Promise<AssistantMessage[]> {
    return this.messages.filter((m) => m.assistantThreadId === threadId);
  }
  async touch(threadId: string, at: Date): Promise<void> {
    const t = this.threads.get(threadId);
    if (t) this.threads.set(threadId, { ...t, lastActiveAt: at });
  }
}

const INPUT: GetOrCreateThreadInput = {
  workspaceId: "ws_1",
  appUserId: "user_1",
  slackChannelId: "D1",
  slackThreadTs: "1700000000.000100",
};

describe("assistantService", () => {
  it("persists a user turn and the generated reply, in order", async () => {
    const store = new FakeAssistantStore();
    const responder: Responder = { async reply() { return "pong"; } };
    const svc = createAssistantService({ store, responder });

    const { reply } = await svc.handleUserMessage(INPUT, "ping", NOW);

    expect(reply).toBe("pong");
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "ping"],
      ["assistant", "pong"],
    ]);
  });

  it("reuses the same thread across turns and passes full history to the responder", async () => {
    const store = new FakeAssistantStore();
    const seen: TurnView[][] = [];
    const responder: Responder = {
      async reply(history) {
        seen.push(history);
        return `reply-${history.length}`;
      },
    };
    const svc = createAssistantService({ store, responder });

    await svc.handleUserMessage(INPUT, "first", NOW);
    await svc.handleUserMessage(INPUT, "second", NOW);

    expect(store.threads.size).toBe(1);
    // Second call's history includes both prior turns plus the new user turn.
    expect(seen[1].map((t) => t.content)).toEqual(["first", "reply-1", "second"]);
  });

  it("streams a reply through the sink and persists the assembled text", async () => {
    const store = new FakeAssistantStore();
    const seen: TurnView[][] = [];
    // A streaming responder: exposes replyStream (deltas) alongside reply().
    const responder: StreamingResponder = {
      async reply() {
        return "unused";
      },
      async *replyStream(history) {
        seen.push(history);
        yield "Here ";
        yield "you ";
        yield "go.";
      },
    };
    const svc = createAssistantService({ store, responder });

    const appended: string[] = [];
    let stopped = false;
    const sink: StreamSink & { stop(): Promise<void> } = {
      async append(text) {
        appended.push(text);
      },
      async stop() {
        stopped = true;
      },
    };

    const { reply } = await svc.handleUserMessageStreaming(INPUT, "ping", NOW, sink, {
      batchChars: 100,
    });

    // Streamed incrementally into the sink, and stop() finalized it.
    expect(appended.join("")).toBe("Here you go.");
    expect(stopped).toBe(true);
    // The user turn was persisted before generation; the assembled reply after.
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "ping"],
      ["assistant", "Here you go."],
    ]);
    expect(reply).toBe("Here you go.");
    // The responder saw the full history (its persisted user turn included).
    expect(seen[0].map((t) => t.content)).toEqual(["ping"]);
  });

  it("falls back to reply() for a non-streaming responder, still driving the sink once", async () => {
    const store = new FakeAssistantStore();
    const responder: Responder = { async reply() { return "canned answer"; } };
    const svc = createAssistantService({ store, responder });

    const appended: string[] = [];
    let stopped = false;
    const sink: StreamSink & { stop(): Promise<void> } = {
      async append(text) {
        appended.push(text);
      },
      async stop() {
        stopped = true;
      },
    };

    const { reply } = await svc.handleUserMessageStreaming(INPUT, "hi", NOW, sink);

    expect(appended.join("")).toBe("canned answer");
    expect(stopped).toBe(true);
    expect(reply).toBe("canned answer");
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "canned answer"],
    ]);
  });

  it("persists a safe fallback (and never appends) when streaming yields nothing", async () => {
    const store = new FakeAssistantStore();
    const responder: StreamingResponder = {
      async reply() {
        return "";
      },
      // eslint-disable-next-line require-yield
      async *replyStream() {
        return; // model produced no text
      },
    };
    const svc = createAssistantService({ store, responder });

    const appended: string[] = [];
    const sink: StreamSink & { stop(): Promise<void> } = {
      async append(text) {
        appended.push(text);
      },
      async stop() {},
    };

    const { reply } = await svc.handleUserMessageStreaming(INPUT, "hi", NOW, sink);

    expect(appended).toHaveLength(0); // nothing to render
    expect(reply).toBe(ASSISTANT_FALLBACK_REPLY);
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", ASSISTANT_FALLBACK_REPLY],
    ]);
  });

  it("startThread records the context channel", async () => {
    const store = new FakeAssistantStore();
    const svc = createAssistantService({ store, responder: createCannedResponder() });

    const thread = await svc.startThread(INPUT, "C_CONTEXT", NOW);
    expect(store.threads.get(thread.id)?.contextChannelId).toBe("C_CONTEXT");
  });

  it("canned responder greets on the first turn and acknowledges afterwards", async () => {
    const r = createCannedResponder("Reviewed");
    expect(await r.reply([{ role: "user", content: "hi" }], "hi")).toContain("Reviewed assistant");
    const later = await r.reply(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "..." },
        { role: "user", content: "again" },
      ],
      "again",
    );
    expect(later).toContain("noted");
  });
});
