// WebClient-backed adapter implementing both Slack ports: SlackGateway (the
// side effects itemService needs — permalink, DM, reactions) and
// SlackInfoGateway (the two lookups the resolver needs — conversations.info,
// users.info). One class so a single per-workspace bot-token WebClient backs
// every Slack call for that workspace. The channel-type inference and the
// channel_not_found handling mirror the classic Channel.fetchInfo.

import type { WebClient } from "@slack/web-api";
import type { ChannelType } from "@prisma/client";
import type { FetchedMessage, SlackGateway } from "../services/ports";
import type {
  ConversationInfo,
  SlackInfoGateway,
  UserProfile,
} from "./resolver";

export class SlackClient implements SlackGateway, SlackInfoGateway {
  constructor(private readonly web: WebClient) {}

  async getPermalink(channelSlackId: string, messageTs: string): Promise<string | null> {
    try {
      const res = await this.web.chat.getPermalink({
        channel: channelSlackId,
        message_ts: messageTs,
      });
      return (res.permalink as string) ?? null;
    } catch {
      return null;
    }
  }

  async postMessage(channel: string, text: string, blocks?: unknown[]): Promise<void> {
    await this.web.chat.postMessage({
      channel,
      text,
      ...(blocks ? { blocks: blocks as never } : {}),
    });
  }

  async addReaction(channelSlackId: string, messageTs: string, name: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel: channelSlackId, name, timestamp: messageTs });
    } catch (err) {
      // already_reacted (or the message being gone) must not fail a completion.
      if (!isBenignReactionError(err)) throw err;
    }
  }

  async removeReaction(channelSlackId: string, messageTs: string, name: string): Promise<void> {
    try {
      await this.web.reactions.remove({ channel: channelSlackId, name, timestamp: messageTs });
    } catch (err) {
      if (!isBenignReactionError(err)) throw err;
    }
  }

  async getMessage(channelSlackId: string, messageTs: string): Promise<FetchedMessage | null> {
    try {
      // conversations.history anchored at the ts (inclusive, limit 1) returns
      // exactly that message — works for a thread parent, which is a normal
      // channel message.
      const res = await this.web.conversations.history({
        channel: channelSlackId,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      });
      const m = (res.messages as HistoryMessage[] | undefined)?.[0];
      if (!m || m.ts !== messageTs) return null;
      return {
        ts: m.ts,
        text: m.text ?? null,
        user: m.user ?? null,
        botId: m.bot_id ?? null,
        threadTs: m.thread_ts ?? null,
        filesJson: m.files ? JSON.stringify(m.files) : null,
      };
    } catch {
      return null;
    }
  }

  async getConversationInfo(slackChannelId: string): Promise<ConversationInfo | null> {
    try {
      const res = await this.web.conversations.info({ channel: slackChannelId });
      const c = res.channel as ConversationsInfoChannel | undefined;
      if (!c) return null;
      return {
        name: c.name_normalized ?? c.name ?? null,
        isMember: Boolean(c.is_member),
        isPrivate: Boolean(c.is_private),
        type: inferChannelType(c),
      };
    } catch (err) {
      // A private channel or DM the bot isn't in surfaces as channel_not_found;
      // the resolver's fallback infers what it can from the id prefix.
      if (errorCode(err) === "channel_not_found") return null;
      throw err;
    }
  }

  async getUserProfile(slackUserId: string): Promise<UserProfile | null> {
    try {
      const res = await this.web.users.info({ user: slackUserId });
      const u = res.user as UsersInfoUser | undefined;
      if (!u) return null;
      return {
        displayName: u.profile?.display_name || u.real_name || u.name || null,
        avatarUrl: u.profile?.image_192 ?? u.profile?.image_72 ?? null,
      };
    } catch (err) {
      if (errorCode(err) === "user_not_found") return null;
      throw err;
    }
  }
}

interface HistoryMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  files?: unknown[];
}

interface ConversationsInfoChannel {
  name?: string;
  name_normalized?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

interface UsersInfoUser {
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    image_72?: string;
    image_192?: string;
  };
}

function inferChannelType(c: ConversationsInfoChannel): ChannelType {
  if (c.is_channel || c.is_group) return c.is_private ? "group" : "channel";
  return c.is_im ? "im" : "mpim";
}

function errorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: string } })?.data;
  return data?.error;
}

function isBenignReactionError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "already_reacted" || code === "no_reaction" || code === "message_not_found";
}
