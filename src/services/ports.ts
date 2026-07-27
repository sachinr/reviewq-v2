// Ports (interfaces) that itemService depends on. Concrete adapters — a
// Prisma-backed ItemRepository and a Bolt WebClient-backed SlackGateway — live
// elsewhere and are integration-tested; the service itself only ever sees these
// interfaces, which is what lets its business logic be unit-tested against
// in-memory fakes with no database, Redis, or live Slack connection.

import type { ChannelType, ClarificationStatus, Item } from "@prisma/client";

export const UNDO_WINDOW_MS = 60_000; // 1 minute — matches the classic app's undo grace period

/** A channel's queue context, already resolved from a Slack payload. */
export interface ChannelContext {
  id: string; // internal Channel id
  workspaceId: string;
  slackChannelId: string;
  isBotMember: boolean;
  type: ChannelType;
}

/** A flagged source message, normalized from whichever Slack surface added it. */
export interface SourceMessage {
  slackMessageTs: string;
  slackThreadTs?: string | null;
  messageText?: string | null;
  authorSlackId: string;
  authorUserId?: string | null; // null for bot/app authors
  filesJson?: string | null;
}

export interface CreateItemData extends SourceMessage {
  workspaceId: string;
  channelId: string;
  flaggedByUserId: string;
  permalink?: string | null;
}

/**
 * The AI-triage outputs attached to one item, joined from ItemSummary /
 * ItemClarificationRequest. `clarificationStatus` is carried raw so the service —
 * not the repo — owns the rule that only a still-*open* clarification is surfaced.
 */
export interface ItemTriageRow {
  itemId: string;
  summary: string | null;
  clarificationQuestion: string | null;
  clarificationStatus: ClarificationStatus | null;
}

export interface ItemRepository {
  findByChannelAndTs(channelId: string, slackMessageTs: string): Promise<Item | null>;
  findById(id: string): Promise<Item | null>;
  create(data: CreateItemData): Promise<Item>;
  markComplete(id: string, completedByUserId: string, completedAt: Date): Promise<Item>;
  markOpen(id: string): Promise<Item>;
  findOpenByChannel(channelId: string): Promise<Item[]>;
  findRecentlyClosedByChannel(channelId: string, since: Date): Promise<Item[]>;
  /** Count open items grouped by channel, for the App Home overview. */
  countOpenByChannelIds(channelIds: string[]): Promise<Array<{ channelId: string; count: number }>>;
  /**
   * Triage annotations for a set of items (only those that have a summary and/or
   * clarification are returned). Used to render summaries/clarifications under the
   * queue rows.
   */
  findTriageByItemIds(itemIds: string[]): Promise<ItemTriageRow[]>;
  /**
   * Count *open* items that still have an *open* clarification request, grouped by
   * channel, for the App Home "needs clarification" signal.
   */
  countOpenClarificationsByChannelIds(
    channelIds: string[],
  ): Promise<Array<{ channelId: string; count: number }>>;
}

/** A single fetched Slack message, normalized for the add-the-parent flow. */
export interface FetchedMessage {
  ts: string;
  text: string | null;
  user?: string | null;
  botId?: string | null;
  threadTs?: string | null;
  filesJson?: string | null;
}

export interface SlackGateway {
  getPermalink(channelSlackId: string, messageTs: string): Promise<string | null>;
  /** Post a message to a channel or a user DM (channel = a U… id posts to that user's DM). */
  postMessage(channel: string, text: string, blocks?: unknown[]): Promise<void>;
  addReaction(channelSlackId: string, messageTs: string, name: string): Promise<void>;
  removeReaction(channelSlackId: string, messageTs: string, name: string): Promise<void>;
  /**
   * Fetch a single message by ts (used to resolve the parent when someone replies
   * `@bot add` in a thread). Null when it can't be read.
   */
  getMessage(channelSlackId: string, messageTs: string): Promise<FetchedMessage | null>;
}

/**
 * A completion notification: the DM Reviewed sends the original author when
 * someone else marks their message done. Carried as data (not a live Slack call)
 * so it can be handed to a durable, retry-safe transport instead of being fired
 * synchronously — `workspaceId` lets the worker re-mint the right per-workspace
 * bot-token client to deliver it.
 */
export interface CompletionNotification {
  workspaceId: string;
  /** The Slack user/id to DM (the flagged message's author). */
  recipientSlackId: string;
  text: string;
}

/**
 * The outbound side of a completion. The old app made this a synchronous
 * fire-and-forget `chat.postMessage`, so a transient Slack failure silently lost
 * the author's notification. The port lets itemService stay ignorant of *how*
 * the DM is delivered: the default inline notifier keeps the direct call (used by
 * unit tests), while production binds a BullMQ-backed notifier that enqueues a
 * `notification-jobs` job for the worker to deliver with retries/backoff.
 */
export interface Notifier {
  notifyCompletion(notification: CompletionNotification): Promise<void>;
}
