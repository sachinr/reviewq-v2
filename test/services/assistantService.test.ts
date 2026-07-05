import type { AssistantMessage, AssistantThread } from "@prisma/client";
import {
  createAssistantService,
  createCannedResponder,
  type AssistantStore,
  type GetOrCreateThreadInput,
  type Responder,
  type TurnView,
} from "../../src/services/assistantService";

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
