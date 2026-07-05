// resolver — turns raw Slack ids from a payload into the internal
// Workspace/Channel/AppUser rows the rest of the app works with. This is the v2
// home for what the classic app spread across Event.findOrCreateSlackObjects,
// Channel.fetchInfo and User.fetchProfile. It depends only on ports (a
// WorkspaceStore for persistence and a SlackInfoGateway for the two Slack
// lookups it needs), so its rules — channel-type inference, the
// channel_not_found fallback for private channels/DMs the bot can't see, and
// lazy profile hydration — are unit-testable with in-memory fakes.

import type { AppUser, Channel, ChannelType, Workspace } from "@prisma/client";
import type { ChannelContext } from "../services/ports";

export interface ConversationInfo {
  name?: string | null;
  isMember: boolean;
  isPrivate: boolean;
  type: ChannelType;
}

export interface UserProfile {
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface SlackInfoGateway {
  /** conversations.info; resolves null when Slack returns channel_not_found. */
  getConversationInfo(slackChannelId: string): Promise<ConversationInfo | null>;
  getUserProfile(slackUserId: string): Promise<UserProfile | null>;
}

export interface UpsertChannelInput {
  workspaceId: string;
  slackChannelId: string;
  name?: string | null;
  type: ChannelType;
  isBotMember: boolean;
  isPrivate: boolean;
}

export interface UpsertUserInput {
  workspaceId: string;
  slackUserId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface WorkspaceStore {
  findWorkspaceByTeamId(slackTeamId: string): Promise<Workspace | null>;
  upsertChannel(input: UpsertChannelInput): Promise<Channel>;
  upsertUser(input: UpsertUserInput): Promise<AppUser>;
}

export interface ResolverDeps {
  store: WorkspaceStore;
  slack: SlackInfoGateway;
}

/**
 * When conversations.info fails with channel_not_found — which happens when a
 * slash command or message action is invoked in a private channel or DM the bot
 * hasn't been added to — infer what we can from the id prefix, matching the
 * classic Channel.fetchInfo fallback. G… is a legacy private group; anything
 * else at that point is a DM.
 */
function fallbackInfo(slackChannelId: string): ConversationInfo {
  const isGroup = slackChannelId.startsWith("G");
  return {
    name: null,
    isMember: false,
    isPrivate: true,
    type: isGroup ? "group" : "im",
  };
}

export function createResolver({ store, slack }: ResolverDeps) {
  async function resolveWorkspace(slackTeamId: string): Promise<Workspace | null> {
    return store.findWorkspaceByTeamId(slackTeamId);
  }

  async function resolveChannel(
    workspace: Workspace,
    slackChannelId: string,
  ): Promise<ChannelContext> {
    const info = (await slack.getConversationInfo(slackChannelId)) ?? fallbackInfo(slackChannelId);
    const channel = await store.upsertChannel({
      workspaceId: workspace.id,
      slackChannelId,
      name: info.name ?? null,
      type: info.type,
      isBotMember: info.isMember,
      isPrivate: info.isPrivate,
    });
    return {
      id: channel.id,
      workspaceId: channel.workspaceId,
      slackChannelId: channel.slackChannelId,
      isBotMember: channel.isBotMember,
      type: channel.type,
    };
  }

  async function resolveUser(workspace: Workspace, slackUserId: string): Promise<AppUser> {
    const profile = await slack.getUserProfile(slackUserId);
    return store.upsertUser({
      workspaceId: workspace.id,
      slackUserId,
      displayName: profile?.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
    });
  }

  return { resolveWorkspace, resolveChannel, resolveUser };
}

export type Resolver = ReturnType<typeof createResolver>;
