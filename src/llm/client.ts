// llm/client.ts — the workspace-scoped LLM wrapper the plan calls for: "All calls
// go through one wrapper module that enforces workspace-scoped isolation,
// timeouts/retries, and cost logging per workspace." Today it exposes exactly one
// capability, the triage TriageModel; future structured LLM features add methods
// here and inherit the same guardrails rather than re-implementing them at each
// call site.
//
// This is a thin I/O adapter (like slackClient / anthropicChat / the Prisma
// stores): the interesting, testable logic — the prompt, the injection
// containment, and the tool-result parsing — lives in ./triagePrompt.ts, which is
// unit-tested. Here we only bind the SDK, apply a timeout/retry, and log cost.

import Anthropic from "@anthropic-ai/sdk";
import type { RawTriage, TriageModel } from "../services/triage";
import {
  TRIAGE_SYSTEM_PROMPT,
  TRIAGE_TOOL,
  TRIAGE_TOOL_NAME,
  buildTriageUserContent,
  parseTriageToolUse,
  type ContentBlockLike,
} from "./triagePrompt";

// Triage is a cheap structured classification, so it defaults to the fast/cheap
// tier (the plan's "fast/cheap tier for structured classification"), overridable
// for cost/quality tuning without a code change.
export const DEFAULT_TRIAGE_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 512;
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

/** Per-workspace cost record, emitted after every classify call. */
export interface TriageUsage {
  workspaceId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TriageClientOptions {
  apiKey: string;
  model?: string;
  /**
   * Where per-workspace token usage is reported. Defaulting to a no-op keeps the
   * adapter silent in tests; production passes a logger that meters cost per
   * workspace (the plan's "cost logging per workspace" guardrail).
   */
  onUsage?: (usage: TriageUsage) => void;
}

/**
 * Build the Anthropic-backed TriageModel. `model` (the resolved model id) is also
 * returned so the caller can stamp it onto the persisted rows for provenance.
 */
export function createTriageModel(opts: TriageClientOptions): TriageModel & { model: string } {
  const model = opts.model ?? process.env.ANTHROPIC_TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODEL;
  const onUsage = opts.onUsage ?? (() => {});
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: MAX_RETRIES });

  return {
    model,
    async classify(workspaceId: string, content: { text: string }): Promise<RawTriage> {
      // Isolation guardrail: one request carries exactly one workspace's content,
      // built fresh here with no shared/accumulated state. The message is the sole
      // user turn and is wrapped as untrusted data — the instructions live only in
      // the system prompt, never concatenated with content.
      const res = await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: TRIAGE_SYSTEM_PROMPT,
          tools: [TRIAGE_TOOL],
          tool_choice: { type: "tool", name: TRIAGE_TOOL_NAME },
          messages: [{ role: "user", content: buildTriageUserContent(content.text) }],
        },
        { timeout: TIMEOUT_MS },
      );

      onUsage({
        workspaceId,
        model,
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      });

      return parseTriageToolUse(res.content as ContentBlockLike[]);
    },
  };
}
