// assistantService — the conversational core of the "AI teammate" surface. In
// Phase 1 this is a skeleton: it persists every turn of a Slack assistant thread
// (so a second message, or a restart, doesn't lose what "that one" referred to)
// and produces a reply through an injected Responder. The canned Responder ships
// now; Phase 2 swaps in an Anthropic-backed one that streams via streamBridge —
// without any change to this service or its callers, because both sides are
// ports.

import type { AssistantMessage, AssistantThread } from "@prisma/client";
import { pumpStream, type PumpOptions, type StreamSink } from "../slack/streamBridge";

export interface TurnView {
  role: "user" | "assistant";
  content: string;
}

/**
 * Shown only if a streamed turn produced no usable text — never a normal
 * outcome. Mirrors anthropicResponder.FALLBACK_REPLY, but lives here so the
 * streaming path (which consumes the raw delta stream, bypassing reply()'s own
 * fallback) has a safe last resort without coupling to the Anthropic module.
 */
export const ASSISTANT_FALLBACK_REPLY =
  "Sorry — I couldn't come up with a reply just now. Please try again.";

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

/**
 * A Responder that can also stream its reply as text deltas. Structurally the
 * same as anthropicResponder.StreamingResponder; declared here (rather than
 * imported) so the service depends only on its own ports. Detected by duck-type
 * so the canned Phase 1 responder (reply-only) still works.
 */
export interface StreamingResponderPort extends Responder {
  replyStream(history: TurnView[], latest: string): AsyncIterable<string>;
}

function canStream(r: Responder): r is StreamingResponderPort {
  return typeof (r as StreamingResponderPort).replyStream === "function";
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

  /**
   * Like handleUserMessage, but renders the reply incrementally into a live
   * StreamSink (Slack's chat.*Stream) instead of returning a single string to
   * say() at the end. When the responder streams, its deltas are pumped through
   * streamBridge (batching + 429 backoff) while being assembled; otherwise the
   * whole reply() is pushed once so the canned responder shares the same path.
   * The assembled text is persisted exactly as before — the stream is a
   * presentation detail, the DB record stays canonical.
   *
   * The caller owns sink.stop(): we finalize it here on the happy path, but the
   * handler should also stop() in a `finally` so a mid-stream error still closes
   * the Slack message.
   */
  async function handleUserMessageStreaming(
    input: GetOrCreateThreadInput,
    text: string,
    now: Date,
    sink: StreamSink & { stop(): Promise<void> },
    pumpOpts?: PumpOptions,
  ): Promise<{ thread: AssistantThread; reply: string }> {
    const thread = await store.getOrCreateThread(input);
    await store.addMessage(thread.id, "user", text);
    const history = (await store.getMessages(thread.id)).map(toTurnView);

    let assembled = "";
    if (canStream(responder)) {
      const source = tapDeltas(responder.replyStream(history, text), (d) => {
        assembled += d;
      });
      await pumpStream(source, sink, pumpOpts);
    } else {
      assembled = await responder.reply(history, text);
      if (assembled.length > 0) await sink.append(assembled);
    }
    await sink.stop();

    const reply = assembled.trim().length > 0 ? assembled.trim() : ASSISTANT_FALLBACK_REPLY;
    await store.addMessage(thread.id, "assistant", reply);
    await store.touch(thread.id, now);
    return { thread, reply };
  }

  return { startThread, handleUserMessage, handleUserMessageStreaming };
}

/** Wrap a delta stream so each chunk is observed (accumulated) as it passes through. */
async function* tapDeltas(
  source: AsyncIterable<string>,
  onDelta: (delta: string) => void,
): AsyncIterable<string> {
  for await (const delta of source) {
    onDelta(delta);
    yield delta;
  }
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
