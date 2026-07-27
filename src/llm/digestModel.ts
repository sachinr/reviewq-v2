// llm/digestModel.ts — the Anthropic-backed DigestModel. A thin I/O adapter, like
// llm/client.ts: the testable logic (the prompt + injection containment) lives in
// ./digestPrompt.ts. The digest is prose, so this is a plain non-streaming
// messages call — no tool. Workspace-scoped per call with a timeout, and
// per-workspace cost logging, matching the plan's "one wrapper module" guardrails.

import Anthropic from "@anthropic-ai/sdk";
import type { DigestModel, StaleItem } from "../services/digest";
import { DIGEST_SYSTEM_PROMPT, buildDigestUserContent, type DigestPromptItem } from "./digestPrompt";

// Digest prose is a mid-tier task (quality of the summary matters more than for
// triage classification), so it defaults to the Sonnet tier, overridable.
export const DEFAULT_DIGEST_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 512;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestUsage {
  workspaceId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface DigestModelOptions {
  apiKey: string;
  model?: string;
  onUsage?: (usage: DigestUsage) => void;
}

export function createDigestModel(opts: DigestModelOptions): DigestModel & { model: string } {
  const model = opts.model ?? process.env.ANTHROPIC_DIGEST_MODEL ?? DEFAULT_DIGEST_MODEL;
  const onUsage = opts.onUsage ?? (() => {});
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: MAX_RETRIES });

  return {
    model,
    async summarize(workspaceId: string, items: StaleItem[]): Promise<string> {
      const now = Date.now();
      const promptItems: DigestPromptItem[] = items.map((it) => ({
        text: (it.summary ?? it.messageText ?? "").trim(),
        ageDays: Math.max(0, Math.floor((now - it.createdAt.getTime()) / DAY_MS)),
        permalink: it.permalink,
      }));

      // Isolation guardrail: one request carries exactly one workspace's items,
      // built fresh here as the sole user turn and wrapped as untrusted data.
      const res = await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: DIGEST_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildDigestUserContent(promptItems) }],
        },
        { timeout: TIMEOUT_MS },
      );

      onUsage({
        workspaceId,
        model,
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      });

      return res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    },
  };
}
