// assistantService — the conversational core of the "AI teammate" surface. In
// Phase 1 this is a skeleton: it persists every turn of a Slack assistant thread
// (so a second message, or a restart, doesn't lose what "that one" referred to)
// and produces a reply through an injected Responder. The canned Responder ships
// now; Phase 2 swaps in an Anthropic-backed one that streams via streamBridge —
// without any change to this service or its callers, because both sides are
// ports.

import type { AssistantMessage, AssistantThread } from "@prisma/client";

export interface TurnView {
  role: "user" | "assistant";
  content: string;
}

export interface GetOrCreateThreadInput {
  workspaceId: string;
  appUserId: string;
  slackChannelId: string;
  slackThreadTs: string;
}

export interface AssistantStore {
  getOrCreateThread(input: GetOrCreateThreadInput): Promise<AssistantThread>;
  setContextChannel(threadId: string, contextChannelId: string | null): Promise<void>;
  addMessage(threadId: string, role: "user" | "assistant", content: string): Promise<AssistantMessage>;
  getMessages(threadId: string): Promise<AssistantMessage[]>;
  touch(threadId: string, at: Date): Promise<void>;
}

/** Produces the assistant's reply given the prior turns and the latest message. */
export interface Responder {
  reply(history: TurnView[], latest: string): Promise<string>;
}

export interface AssistantServiceDeps {
  store: AssistantStore;
  responder: Responder;
}

export function createAssistantService({ store, responder }: AssistantServiceDeps) {
  async function startThread(input: GetOrCreateThreadInput, contextChannelId: string | null, now: Date) {
    const thread = await store.getOrCreateThread(input);
    if (contextChannelId) await store.setContextChannel(thread.id, contextChannelId);
    await store.touch(thread.id, now);
    return thread;
  }

  /**
   * Persist the user's message, generate a reply from the full history (so the
   * Responder has the whole conversation, not just this turn), persist the
   * reply, and return it for the caller to say() back into Slack.
   */
  async function handleUserMessage(
    input: GetOrCreateThreadInput,
    text: string,
    now: Date,
  ): Promise<{ thread: AssistantThread; reply: string }> {
    const thread = await store.getOrCreateThread(input);
    await store.addMessage(thread.id, "user", text);

    const history = (await store.getMessages(thread.id)).map(toTurnView);
    const reply = await responder.reply(history, text);

    await store.addMessage(thread.id, "assistant", reply);
    await store.touch(thread.id, now);
    return { thread, reply };
  }

  return { startThread, handleUserMessage };
}

export type AssistantService = ReturnType<typeof createAssistantService>;

function toTurnView(m: AssistantMessage): TurnView {
  return { role: m.role as "user" | "assistant", content: m.content };
}

/**
 * The Phase 1 stand-in responder: no LLM, just a friendly acknowledgment that
 * still proves the persistence + wiring path end-to-end. Phase 2 replaces this
 * with an Anthropic-backed Responder.
 */
export function createCannedResponder(appName = "Reviewed"): Responder {
  return {
    async reply(history: TurnView[]): Promise<string> {
      const userTurns = history.filter((t) => t.role === "user").length;
      if (userTurns <= 1) {
        return (
          `Hi! I'm the ${appName} assistant. I can help you keep track of review items. ` +
          `Full AI answers are coming soon — for now, use the message action on any message to add it to your queue.`
        );
      }
      return "Got it — I've noted that. (AI replies are still being wired up.)";
    },
  };
}
