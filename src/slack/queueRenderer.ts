// queueRenderer — the ONE Block Kit builder for the queue list. The classic app
// had two near-duplicate pagination implementations (Message.ts and View.ts,
// each with its own PER_PAGE=3); this collapses them so the slash command, the
// "View all" modal, App Home, and assistant replies all render identically.
// Pure and deterministic: no I/O, no Slack client — trivially unit-testable.

import type { Item } from "@prisma/client";
import type { Button, KnownBlock } from "@slack/types";

export const PAGE_SIZE = 5;

export const ACTION_COMPLETE_ITEM = "complete_item";
export const ACTION_UNDO_ITEM = "undo_item";
export const ACTION_QUEUE_PAGE = "queue_page";

/**
 * Per-item AI-triage output surfaced beneath a queue row. Structural (not the
 * Prisma row) so the pure renderer stays free of DB types — itemService produces
 * a compatible shape. Both fields optional/nullable: triage may skip an item,
 * produce only a summary, or leave a since-resolved clarification off entirely.
 */
export interface ItemAnnotation {
  summary?: string | null;
  clarificationQuestion?: string | null;
}

export interface RenderQueueInput {
  /** The combined open + recently-closed "all" list from itemService. */
  items: Item[];
  /** 1-based page number; clamped into range. Defaults to 1. */
  page?: number;
  channelName?: string | null;
  /** AI-triage annotations keyed by item id; only the current page's are read. */
  annotations?: Record<string, ItemAnnotation>;
}

export interface RenderedQueue {
  blocks: KnownBlock[];
  totalPages: number;
  page: number;
}

export function renderQueue({ items, page = 1, channelName, annotations }: RenderQueueInput): RenderedQueue {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = clamp(page, 1, totalPages);

  if (items.length === 0) {
    return {
      blocks: [sectionText(":sparkles: *There are no items in your queue.*")],
      totalPages,
      page: current,
    };
  }

  const start = (current - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  const blocks: KnownBlock[] = [];
  const heading = channelName ? `*Review queue for #${channelName}*` : "*Review queue*";
  blocks.push(sectionText(heading));
  blocks.push({ type: "divider" });

  for (const item of pageItems) {
    blocks.push(itemSection(item));
    const context = annotationContext(annotations?.[item.id]);
    if (context) blocks.push(context);
  }

  if (totalPages > 1) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Page ${current} of ${totalPages}` }],
    });
    blocks.push(paginationControls(current, totalPages));
  }

  return { blocks, totalPages, page: current };
}

function itemSection(item: Item): KnownBlock {
  const isDone = item.status === "complete";
  const label = item.messageText?.trim() || "_(no message text)_";
  const linked = item.permalink ? `<${item.permalink}|${label}>` : label;
  const text = isDone ? `~${linked}~ :white_check_mark:` : linked;

  const accessory = isDone
    ? button("Undo", ACTION_UNDO_ITEM, item.id)
    : button("Mark as Done", ACTION_COMPLETE_ITEM, item.id, "primary");

  return {
    type: "section",
    text: { type: "mrkdwn", text },
    accessory,
  };
}

/**
 * A context block rendered under an item carrying its triage output: the LLM
 * summary and, only while still open, the clarifying question. Returns null when
 * there is nothing to show, so a plain (un-triaged) item renders exactly as before.
 */
function annotationContext(ann?: ItemAnnotation): KnownBlock | null {
  if (!ann) return null;
  const parts: string[] = [];
  const summary = ann.summary?.trim();
  if (summary) parts.push(`:memo: ${summary}`);
  const question = ann.clarificationQuestion?.trim();
  if (question) parts.push(`:grey_question: *Needs clarification:* ${question}`);
  if (parts.length === 0) return null;
  return { type: "context", elements: [{ type: "mrkdwn", text: parts.join("\n") }] };
}

function paginationControls(current: number, totalPages: number): KnownBlock {
  const elements = [];
  if (current > 1) {
    elements.push(pageButton("← Prev", current - 1));
  }
  if (current < totalPages) {
    elements.push(pageButton("Next →", current + 1));
  }
  return { type: "actions", elements };
}

function pageButton(text: string, page: number) {
  return {
    type: "button" as const,
    text: { type: "plain_text" as const, text },
    action_id: ACTION_QUEUE_PAGE,
    value: JSON.stringify({ page }),
  };
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger"): Button {
  const b: Button = {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
  };
  if (style) b.style = style;
  return b;
}

function sectionText(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
