// anthropicResponder — Phase 2's real "AI teammate" brain. It implements the
// exact same Responder port the Phase 1 canned stand-in did, so neither
// assistantService nor app.ts change to adopt it — only the wiring picks a
// different implementation. Replies are generated from Anthropic's Messages API,
// but this module depends only on the AnthropicChat port (a text-delta stream),
// so it is fully unit-tested here against a fake with no SDK and no network. The
// SDK-backed adapter lives in src/slack/anthropicChat.ts.
//
// The delta stream is also exposed directly (replyStream) so the live Slack path
// can forward tokens through streamBridge for rate-respecting incremental
// rendering, instead of only ever seeing the final string.

import type { Responder, TurnView } from "./assistantService";

/** One turn in Anthropic's Messages format. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The one capability the responder needs from Anthropic: given a system prompt
 * and the prior turns, stream back the reply as text deltas. Kept as a port so
 * the core is testable; the SDK-backed implementation is createAnthropicChat.
 */
export interface AnthropicChat {
  stream(system: string, messages: ChatMessage[]): AsyncIterable<string>;
}

/** A Responder that also exposes the raw delta stream (for streamBridge). */
export interface StreamingResponder extends Responder {
  replyStream(history: TurnView[], latest: string): AsyncIterable<string>;
}

export interface AnthropicResponderDeps {
  chat: AnthropicChat;
  appName?: string;
  /** Override the default system prompt (mainly for tests). */
  systemPrompt?: string;
}

/** Shown only if the model returns nothing usable — never a normal outcome. */
export const FALLBACK_REPLY =
  "Sorry — I couldn't come up with a reply just now. Please try again.";

export function createAnthropicResponder(deps: AnthropicResponderDeps): StreamingResponder {
  const system = deps.systemPrompt ?? defaultSystemPrompt(deps.appName ?? "Reviewed");

  function replyStream(history: TurnView[], latest: string): AsyncIterable<string> {
    return deps.chat.stream(system, toChatMessages(history, latest));
  }

  async function reply(history: TurnView[], latest: string): Promise<string> {
    let full = "";
    for await (const delta of replyStream(history, latest)) full += delta;
    const trimmed = full.trim();
    return trimmed.length > 0 ? trimmed : FALLBACK_REPLY;
  }

  return { reply, replyStream };
}

/**
 * assistantService persists the user's turn *before* calling the responder, so
 * `history` already ends with the latest user message; we build the request from
 * history and only fall back to `latest` if history somehow arrives empty (e.g. a
 * caller that hasn't persisted yet).
 */
function toChatMessages(history: TurnView[], latest: string): ChatMessage[] {
  if (history.length === 0) return [{ role: "user", content: latest }];
  return history.map((t) => ({ role: t.role, content: t.content }));
}

export function defaultSystemPrompt(appName: string): string {
  return [
    `You are ${appName}, a friendly assistant that lives inside Slack and helps`,
    `people track and clear their review queue. A "review item" is any Slack`,
    `message a user has flagged to come back to later.`,
    ``,
    `How the product works, so you can guide people accurately:`,
    `- Add an item: use the "Add to review queue" message action on any message.`,
    `- Complete or undo an item: the buttons on the queue (undo has a short window).`,
    `- View a channel's queue: the slash command (add "private" to keep it to yourself).`,
    ``,
    `Be concise and conversational — you're replying in a Slack thread, not writing`,
    `documentation. You cannot read or modify someone's queue directly yet, so`,
    `explain how to do things rather than inventing item contents or claiming an`,
    `action has been taken. If you don't know, say so plainly.`,
  ].join("\n");
}
