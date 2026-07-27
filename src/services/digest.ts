// digest — the scheduled "staleness digest" core. A repeatable job periodically
// asks: for each channel, which open items have been sitting too long, and what's
// the one-paragraph story of what's stuck? This module owns the *rules* — the
// staleness threshold, which items to send the model, the cap, and suppressing an
// empty digest — and depends only on the DigestModel port, so it is unit-tested
// against a fake with no SDK, DB, or Slack. The Anthropic-backed model lives in
// src/llm/digestModel.ts; the job wiring in src/jobs/digestQueue.ts.
//
// Like triage, this only ever *reads* item content and produces prose — it runs
// no queue action — so a stale item whose text says "mark everything done" can at
// worst skew the summary. The model still receives item text as clearly-delimited
// untrusted data (see src/llm/digestPrompt.ts).

/** The per-item fields a digest needs. `createdAt` drives the staleness decision. */
export interface StaleItem {
  id: string;
  messageText: string | null;
  permalink: string | null;
  createdAt: Date;
  /** Optional AI-triage summary, preferred over raw text when present. */
  summary?: string | null;
}

/**
 * The one capability the digest needs from Claude: given a channel's stale items,
 * write a short prose digest. `workspaceId` is passed through so the adapter can
 * scope cost logging and assert single-workspace isolation per call.
 */
export interface DigestModel {
  summarize(workspaceId: string, items: StaleItem[]): Promise<string>;
}

export interface DigestOutcome {
  /** True when there is a non-empty digest worth posting. */
  hasDigest: boolean;
  /** Every open item the run looked at. */
  itemsConsidered: number;
  /** How many of those were past the staleness threshold. */
  staleItems: number;
  /** The prose digest to post, or null when there's nothing to say. */
  summaryText: string | null;
}

/** An open item is "stale" once it has been open at least this long. Default: 7 days. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Never send more than this many items to the model in one digest — a channel
 * with hundreds of stale items should still produce a bounded prompt (and a
 * readable digest). The oldest items are kept.
 */
export const MAX_DIGEST_ITEMS = 20;

/**
 * Decide what (if anything) to digest for one channel's open items:
 *  - filter to items open at least STALE_AFTER_MS (>= threshold counts as stale);
 *  - if none are stale, return no digest and make NO model call (don't burn tokens);
 *  - otherwise summarize the stale items oldest-first, capped to MAX_DIGEST_ITEMS;
 *  - suppress the digest if the model returns only whitespace (never post an empty one).
 */
export async function computeStaleDigest(
  openItems: StaleItem[],
  now: Date,
  model: DigestModel,
  workspaceId: string,
): Promise<DigestOutcome> {
  const itemsConsidered = openItems.length;

  const stale = openItems
    .filter((it) => now.getTime() - it.createdAt.getTime() >= STALE_AFTER_MS)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()); // oldest first

  if (stale.length === 0) {
    return { hasDigest: false, itemsConsidered, staleItems: 0, summaryText: null };
  }

  const forModel = stale.slice(0, MAX_DIGEST_ITEMS);
  const raw = await model.summarize(workspaceId, forModel);
  const summaryText = raw.trim();

  if (summaryText.length === 0) {
    return { hasDigest: false, itemsConsidered, staleItems: stale.length, summaryText: null };
  }

  return { hasDigest: true, itemsConsidered, staleItems: stale.length, summaryText };
}
