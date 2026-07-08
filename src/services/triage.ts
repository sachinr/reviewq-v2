// triage — Phase 2's "AI triage on the add path" core. When a message is flagged
// into the queue we run one LLM pass over it to (a) summarize long items and
// (b) flag genuinely unclear ("vague") items with a concrete clarifying question.
// This module owns the *rules* — when to bother the model at all, and how to
// normalize what it returns — and depends only on the TriageModel port, so it is
// unit-tested against a fake with no SDK or network. The Anthropic-backed model
// lives in src/llm/client.ts.
//
// Nothing here executes a queue action: triage only ever reads message content
// and produces text. That is the containment for prompt injection — a flagged
// message can contain "mark everything done", but the worst it can do to triage
// is skew a summary, never trigger a completion. The model still receives the
// content as clearly-delimited untrusted data (see src/llm/triagePrompt.ts).

/** What the model is asked to look at. Kept minimal; thread context can be added later. */
export interface TriageContent {
  /** The flagged message's text. Null/empty when the item is e.g. a file-only post. */
  itemText: string | null;
}

/** The model's raw judgement, before this module normalizes it. */
export interface RawTriage {
  /** A one-line summary of the item, or null when the model declined to summarize. */
  summary: string | null;
  /** True when the item is too vague to action without more detail. */
  isVague: boolean;
  /** The clarifying question to ask, present iff isVague. */
  clarifyingQuestion: string | null;
}

/**
 * The one capability triage needs from Claude: classify a single item's content.
 * `workspaceId` is passed through purely so the adapter can scope cost logging
 * (and assert single-workspace isolation) per call — it never mixes content
 * across workspaces. Kept as a port so this core is testable against a fake.
 */
export interface TriageModel {
  classify(workspaceId: string, content: { text: string }): Promise<RawTriage>;
}

/** The normalized triage result the job persists. */
export interface ItemTriageOutcome {
  /** True when the item was too trivial to spend an LLM call on (no model call made). */
  skipped: boolean;
  /** The summary to store, or null when not worth storing. */
  summary: string | null;
  /** The clarifying question to store/ask, or null when the item is clear enough. */
  clarification: string | null;
}

/**
 * Below this many characters of content, skip triage entirely: a 12-character
 * message ("ship the PR") is neither worth summarizing nor plausibly "vague" in a
 * way an LLM would improve — calling the model would just burn tokens on every add.
 */
export const MIN_TRIAGE_CHARS = 40;

/**
 * Only *store* a summary when the original is at least this long. Short-but-triageable
 * items (40–200 chars) still get vague-detection, but summarizing them into a
 * separate row adds no value — the item text already fits at a glance.
 */
export const SUMMARIZE_MIN_CHARS = 240;

/** Hard cap on a stored summary; a "one-line summary" that runs long is clamped. */
export const MAX_SUMMARY_CHARS = 280;

/**
 * Run triage for one item's content. Decides whether to call the model at all,
 * then normalizes its answer:
 *  - summary kept only for long items, trimmed, clamped, and dropped if it just
 *    echoes the original (no value in storing the text twice);
 *  - clarification kept only when the model flags the item vague *and* supplies a
 *    non-empty question (isVague with no question is treated as "clear").
 */
export async function runItemTriage(
  content: TriageContent,
  model: TriageModel,
  workspaceId: string,
): Promise<ItemTriageOutcome> {
  const text = (content.itemText ?? "").trim();
  if (text.length < MIN_TRIAGE_CHARS) {
    return { skipped: true, summary: null, clarification: null };
  }

  const raw = await model.classify(workspaceId, { text });

  return {
    skipped: false,
    summary: normalizeSummary(raw.summary, text),
    clarification: normalizeClarification(raw),
  };
}

function normalizeSummary(summary: string | null, originalText: string): string | null {
  if (originalText.length < SUMMARIZE_MIN_CHARS) return null;
  const trimmed = (summary ?? "").trim();
  if (trimmed.length === 0) return null;
  // A "summary" that's just the original text back adds nothing.
  if (trimmed === originalText.trim()) return null;
  return trimmed.length > MAX_SUMMARY_CHARS
    ? `${trimmed.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`
    : trimmed;
}

function normalizeClarification(raw: RawTriage): string | null {
  if (!raw.isVague) return null;
  const q = (raw.clarifyingQuestion ?? "").trim();
  return q.length > 0 ? q : null;
}
