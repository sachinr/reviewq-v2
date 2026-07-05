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
  type SlackGateway,
  type SourceMessage,
} from "./ports";

const DONE_REACTION = "white_check_mark";

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
}

export function createItemService({ repo, slack }: ItemServiceDeps) {
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

    const item = await repo.markComplete(itemId, completer.userId, now);

    if (channel.isBotMember) {
      await slack.addReaction(channel.slackChannelId, item.slackMessageTs, DONE_REACTION);
    }

    let notifiedAuthor = false;
    if (item.authorSlackId !== completer.slackId) {
      await slack.postMessage(item.authorSlackId, completionDmText(item, completer.slackId));
      notifiedAuthor = true;
    }

    return { item, notifiedAuthor };
  }

  async function undoComplete(itemId: string, channel: ChannelContext, now: Date): Promise<UndoResult> {
    const existing = await repo.findById(itemId);
    if (!existing) throw new Error(`undoComplete: item ${itemId} not found`);

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

  async function openAndRecentlyClosedItems(channel: ChannelContext, now: Date): Promise<QueueView> {
    const open = await repo.findOpenByChannel(channel.id);
    const since = new Date(now.getTime() - UNDO_WINDOW_MS);
    const recentlyClosed = await repo.findRecentlyClosedByChannel(channel.id, since);
    const all = [...open, ...recentlyClosed].sort(byCreation);
    return { open, recentlyClosed, all };
  }

  return { createItem, completeItem, undoComplete, listOpenItems, openAndRecentlyClosedItems };
}

export type ItemService = ReturnType<typeof createItemService>;

function byCreation(a: Item, b: Item): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

function completionDmText(item: Item, completerSlackId: string): string {
  const link = item.permalink ? `<${item.permalink}|Your message>` : "Your message";
  return `:white_check_mark: ${link} was marked as complete by <@${completerSlackId}>`;
}
