// Ports (interfaces) that itemService depends on. Concrete adapters — a
// Prisma-backed ItemRepository and a Bolt WebClient-backed SlackGateway — live
// elsewhere and are integration-tested; the service itself only ever sees these
// interfaces, which is what lets its business logic be unit-tested against
// in-memory fakes with no database, Redis, or live Slack connection.

import type { ChannelType, Item } from "@prisma/client";

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
