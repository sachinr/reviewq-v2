// anthropicToolChat — the SDK-backed adapter for the tool-calling chat ports. Like
// anthropicChat (the plain streaming responder's adapter) and llm/client (the
// triage adapter), it is a thin I/O binding: it wraps an Anthropic Messages call
// with tools and translates between the loop's provider-agnostic
// LoopMessage/AssistantTurn vocabulary and the SDK's block shapes. The
// interesting control flow lives in services/toolLoop.ts; the fiddly (and
// therefore separately unit-tested) part here is that block translation,
// exported as pure functions so it can be exercised without the SDK.
//
// It implements BOTH ports:
//   - runTurn (ToolCallingChat): one non-streaming call, used by the pure loop.
//   - streamTurn (StreamingToolCallingChat): the same call as a stream, so the
//     model's assistant text renders into Slack token-by-token via the live sink.
// A tool-use turn is still received in full before its tool_use blocks can be
// executed — you can't act on a tool call mid-token — so streamTurn forwards the
// text deltas as they arrive and resolves the full turn (text + tool calls) via
// the stream's finalMessage(); the loop runs any tool calls once that resolves.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import type { AssistantTool } from "../services/assistantTools";
import type {
  AssistantTurn,
  LoopMessage,
  StreamedTurn,
  StreamingToolCallingChat,
  ToolCallingChat,
} from "../services/toolLoop";

// The conversational/tool tier — the plan's "mid tier for conversational
// replies". Overridable via ANTHROPIC_TOOL_MODEL (falling back to the shared
// ANTHROPIC_MODEL) for cost/quality tuning without a code change.
export const DEFAULT_TOOL_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export function createAnthropicToolChat(
  apiKey: string,
  model: string = process.env.ANTHROPIC_TOOL_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_TOOL_MODEL,
): ToolCallingChat & StreamingToolCallingChat {
  const client = new Anthropic({ apiKey, maxRetries: MAX_RETRIES });

  function requestBody(input: { system: string; messages: LoopMessage[]; tools: AssistantTool[] }) {
    return {
      model,
      max_tokens: MAX_TOKENS,
      system: input.system,
      tools: input.tools.map(toAnthropicTool),
      messages: input.messages.map(toAnthropicMessage),
    };
  }

  return {
    async runTurn(input): Promise<AssistantTurn> {
      const res = await client.messages.create(requestBody(input), { timeout: TIMEOUT_MS });
      return toAssistantTurn(res.content as ContentBlock[]);
    },

    streamTurn(input): StreamedTurn {
      const stream = client.messages.stream(requestBody(input), { timeout: TIMEOUT_MS });
      async function* deltas(): AsyncIterable<string> {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield event.delta.text;
          }
        }
      }
      // finalMessage() resolves once the stream (drained by the loop via deltas)
      // completes, carrying the full block list including any tool_use blocks.
      const turn = stream.finalMessage().then((msg) => toAssistantTurn(msg.content as ContentBlock[]));
      return { deltas: deltas(), turn };
    },
  };
}

/** Strip the loop's `mutating` flag; the SDK tool shape is name/description/schema. */
export function toAnthropicTool(tool: AssistantTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Tool.InputSchema,
  };
}

/** Translate one LoopMessage into an Anthropic MessageParam. */
export function toAnthropicMessage(m: LoopMessage): MessageParam {
  if (m.role === "user") {
    return { role: "user", content: m.text };
  }
  if (m.role === "assistant") {
    // Text (if any) then the tool_use blocks, in one assistant turn.
    const content: MessageParam["content"] = [];
    if (m.text.trim().length > 0) content.push({ type: "text", text: m.text });
    for (const use of m.toolUses) {
      content.push({ type: "tool_use", id: use.id, name: use.name, input: use.input });
    }
    // An assistant turn must be non-empty; if somehow it is, send a space so the
    // API doesn't reject the transcript.
    return { role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: " " }] };
  }
  // tool_results — Anthropic carries these as a user turn of tool_result blocks,
  // which must immediately follow the assistant turn that requested them.
  return {
    role: "user",
    content: m.results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolUseId,
      content: r.content,
      is_error: r.isError,
    })),
  };
}

/** Collapse the model's response content blocks into the loop's AssistantTurn. */
export function toAssistantTurn(content: ContentBlock[]): AssistantTurn {
  let text = "";
  const toolUses: AssistantTurn["toolUses"] = [];
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolUses.push({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return { text, toolUses };
}
