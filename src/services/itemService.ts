// itemService — the single home for the review-queue's core rules, replacing the
// logic that the classic app scattered across Item.ts and Channel.ts (fat
// TypeORM models that doubled as Slack API wrappers). It depends only on the
// ItemRepository and SlackGateway ports, so every rule here is unit-testable
// against in-memory fakes. Slack side effects that must happen regardless of
// which surface triggered them (the ✅ reaction, the author DM) live here;
// surface-specific confirmations (ephemeral vs response_url vs channel post)
// stay in the listeners.

import type { Item } from "@prisma/client";
import {
  UNDO_WINDOW_MS,
  type ChannelContext,
  type ItemRepository,
  type Notifier,
  type SlackGateway,
  type SourceMessage,
} from "./ports";

const DONE_REACTION = "white_check_mark";

/**
 * Authorization boundary. An item is mutated by id taken from a button value (and
 * in Phase 3 from an LLM tool call), so before touching it we assert it actually
 * belongs to the channel/workspace the request was resolved against. Not
 * exploitable via signed Slack payloads today, but this is the plan's stated
 * authorization boundary and becomes load-bearing once the assistant mutates
 * items by natural language.
 */
function assertOwnership(item: Item, channel: ChannelContext, op: string): void {
  if (item.channelId !== channel.id || item.workspaceId !== channel.workspaceId) {
    throw new Error(`${op}: item ${item.id} does not belong to channel ${channel.id}`);
  }
}

export interface CreateItemResult {
  item: Item;
  /** true when an identical open item already existed (no-op add). */
  wasDuplicate: boolean;
  /** true when a previously-completed item was reopened by re-adding it. */
  wasReopened: boolean;
}

export interface CompleteItemResult {
  item: Item;
  /** true when the original author was DM'd (i.e. completer !== author). */
  notifiedAuthor: boolean;
}

export interface UndoResult {
  item: Item;
  /** false when the undo window had already elapsed (no mutation performed). */
  withinWindow: boolean;
}

export interface QueueView {
  open: Item[];
  recentlyClosed: Item[];
  all: Item[];
}

export interface ItemServiceDeps {
  repo: ItemRepository;
  slack: SlackGateway;
  /**
   * How the author's completion DM is delivered. Defaults to an inline notifier
   * that posts straight through the SlackGateway — which keeps the pure unit
   * tests DB/Redis-free. Production injects the BullMQ-backed notifier so the DM
   * survives transient Slack failures via the worker's retry/backoff.
   */
  notifier?: Notifier;
}

export function createItemService({ repo, slack, notifier }: ItemServiceDeps) {
  const notify = notifier ?? createInlineNotifier(slack);

  async function createItem(
    channel: ChannelContext,
    source: SourceMessage,
    flaggedByUserId: string,
  ): Promise<CreateItemResult> {
    const existing = await repo.findByChannelAndTs(channel.id, source.slackMessageTs);
    if (existing) {
      if (existing.status === "complete") {
        const reopened = await repo.markOpen(existing.id);
        return { item: reopened, wasDuplicate: false, wasReopened: true };
      }
      return { item: existing, wasDuplicate: true, wasReopened: false };
    }

    const permalink = await slack.getPermalink(channel.slackChannelId, source.slackMessageTs);
    const item = await repo.create({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      slackMessageTs: source.slackMessageTs,
      slackThreadTs: source.slackThreadTs ?? null,
      messageText: source.messageText ?? null,
      authorSlackId: source.authorSlackId,
      authorUserId: source.authorUserId ?? null,
      filesJson: source.filesJson ?? null,
      flaggedByUserId,
      permalink,
    });
    return { item, wasDuplicate: false, wasReopened: false };
  }

  async function completeItem(
    itemId: string,
    channel: ChannelContext,
    completer: { userId: string; slackId: string },
    now: Date,
  ): Promise<CompleteItemResult> {
    const existing = await repo.findById(itemId);
    if (!existing) throw new Error(`completeItem: item ${itemId} not found`);
    assertOwnership(existing, channel, "completeItem");

    const item = await repo.markComplete(itemId, completer.userId, now);

    if (channel.isBotMember) {
      await slack.addReaction(channel.slackChannelId, item.slackMessageTs, DONE_REACTION);
    }

    let notifiedAuthor = false;
    if (item.authorSlackId !== completer.slackId) {
      await notify.notifyCompletion({
        workspaceId: item.workspaceId,
        recipientSlackId: item.authorSlackId,
        text: completionDmText(item, completer.slackId),
      });
      notifiedAuthor = true;
    }

    return { item, notifiedAuthor };
  }

  /**
   * Complete the open item attached to a given source message ts, if one exists.
   * This is the entry point for the classic `@bot done` (as a thread reply): the
   * listener resolves the target message ts, we look the item up channel-scoped
   * and complete it — reusing completeItem so the ✅ reaction + author DM fire
   * identically. Returns null when there is no open item for that message (a
   * `done` on something that was never queued, or already completed).
   */
  async function completeItemByMessageTs(
    channel: ChannelContext,
    messageTs: string,
    completer: { userId: string; slackId: string },
    now: Date,
  ): Promise<CompleteItemResult | null> {
    const existing = await repo.findByChannelAndTs(channel.id, messageTs);
    if (!existing || existing.status !== "open") return null;
    return completeItem(existing.id, channel, completer, now);
  }

  async function undoComplete(itemId: string, channel: ChannelContext, now: Date): Promise<UndoResult> {
    const existing = await repo.findById(itemId);
    if (!existing) throw new Error(`undoComplete: item ${itemId} not found`);
    assertOwnership(existing, channel, "undoComplete");

    const within =
      existing.completedAt != null && now.getTime() - existing.completedAt.getTime() <= UNDO_WINDOW_MS;
    if (!within) {
      return { item: existing, withinWindow: false };
    }

    const item = await repo.markOpen(itemId);
    if (channel.isBotMember) {
      await slack.removeReaction(channel.slackChannelId, item.slackMessageTs, DONE_REACTION);
    }
    return { item, withinWindow: true };
  }

  async function listOpenItems(channel: ChannelContext): Promise<Item[]> {
    return repo.findOpenByChannel(channel.id);
  }

  /**
   * Open-item counts for a set of channels, for the App Home overview. Channels
   * with no open items are simply absent from the result (callers default to 0).
   */
  async function openCountsByChannels(
    channelIds: string[],
  ): Promise<Array<{ channelId: string; count: number }>> {
    return repo.countOpenByChannelIds(channelIds);
  }

  async function openAndRecentlyClosedItems(channel: ChannelContext, now: Date): Promise<QueueView> {
    const open = await repo.findOpenByChannel(channel.id);
    const since = new Date(now.getTime() - UNDO_WINDOW_MS);
    const recentlyClosed = await repo.findRecentlyClosedByChannel(channel.id, since);
    const all = [...open, ...recentlyClosed].sort(byCreation);
    return { open, recentlyClosed, all };
  }

  return {
    createItem,
    completeItem,
    completeItemByMessageTs,
    undoComplete,
    listOpenItems,
    openAndRecentlyClosedItems,
    openCountsByChannels,
  };
}

export type ItemService = ReturnType<typeof createItemService>;

/**
 * The default `Notifier`: deliver the completion DM synchronously through the
 * SlackGateway, exactly as the service did before the queue existed. Used by unit
 * tests and as a safe fallback when no durable notifier is injected.
 */
function createInlineNotifier(slack: SlackGateway): Notifier {
  return {
    async notifyCompletion({ recipientSlackId, text }) {
      await slack.postMessage(recipientSlackId, text);
    },
  };
}

function byCreation(a: Item, b: Item): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

function completionDmText(item: Item, completerSlackId: string): string {
  const link = item.permalink ? `<${item.permalink}|Your message>` : "Your message";
  return `:white_check_mark: ${link} was marked as complete by <@${completerSlackId}>`;
}
