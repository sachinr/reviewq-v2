// anthropicChat — the SDK-backed adapter for the AnthropicChat port. Thin and
// I/O-bound (like slackClient and the Prisma stores): it wraps the Anthropic
// Messages streaming API and yields only the text deltas, so the tested
// responder core never imports the SDK. The model is configurable via
// ANTHROPIC_MODEL for cost/quality tuning without a code change.

import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicChat, ChatMessage } from "../services/anthropicResponder";

export const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

export function createAnthropicChat(
  apiKey: string,
  model: string = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
): AnthropicChat {
  const client = new Anthropic({ apiKey });
  return {
    async *stream(system: string, messages: ChatMessage[]): AsyncIterable<string> {
      const s = client.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      for await (const event of s) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
    },
  };
}
