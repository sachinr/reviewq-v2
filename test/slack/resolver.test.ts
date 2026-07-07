import type { AppUser, Channel, Workspace } from "@prisma/client";
import {
  createResolver,
  type ConversationInfo,
  type SlackInfoGateway,
  type UpsertChannelInput,
  type UpsertUserInput,
  type UserProfile,
  type WorkspaceStore,
} from "../../src/slack/resolver";

const WORKSPACE: Workspace = {
  id: "ws_1",
  slackTeamId: "T1",
  slackEnterpriseId: null,
  name: "Acme",
  botUserId: "UBOT",
  botTokenEncrypted: "enc",
  botScopes: "chat:write",
  isActive: true,
  installedAt: new Date("2026-01-01T00:00:00Z"),
  uninstalledAt: null,
};

class FakeStore implements WorkspaceStore {
  workspaces = new Map<string, Workspace>();
  channelUpserts: UpsertChannelInput[] = [];
  userUpserts: UpsertUserInput[] = [];

  async findWorkspaceByTeamId(slackTeamId: string): Promise<Workspace | null> {
    return [...this.workspaces.values()].find((w) => w.slackTeamId === slackTeamId) ?? null;
  }
  async upsertChannel(input: UpsertChannelInput): Promise<Channel> {
    this.channelUpserts.push(input);
    return {
      id: "chan_1",
      workspaceId: input.workspaceId,
      slackChannelId: input.slackChannelId,
      name: input.name ?? null,
      type: input.type,
      isBotMember: input.isBotMember,
      isPrivate: input.isPrivate,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
  }
  async upsertUser(input: UpsertUserInput): Promise<AppUser> {
    this.userUpserts.push(input);
    return {
      id: "user_1",
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      userTokenEncrypted: null,
      isInstaller: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
  }
  async listChannels(): Promise<Channel[]> {
    return [];
  }
}

class FakeInfoGateway implements SlackInfoGateway {
  convInfo: ConversationInfo | null = {
    name: "general",
    isMember: true,
    isPrivate: false,
    type: "channel",
  };
  profile: UserProfile | null = { displayName: "Ada", avatarUrl: "http://img/ada.png" };

  async getConversationInfo(): Promise<ConversationInfo | null> {
    return this.convInfo;
  }
  async getUserProfile(): Promise<UserProfile | null> {
    return this.profile;
  }
}

describe("resolver", () => {
  it("resolves a known workspace and null for an unknown team", async () => {
    const store = new FakeStore();
    store.workspaces.set(WORKSPACE.id, WORKSPACE);
    const resolver = createResolver({ store, slack: new FakeInfoGateway() });

    expect(await resolver.resolveWorkspace("T1")).toEqual(WORKSPACE);
    expect(await resolver.resolveWorkspace("T-unknown")).toBeNull();
  });

  it("upserts a channel from conversations.info and returns a ChannelContext", async () => {
    const store = new FakeStore();
    const slack = new FakeInfoGateway();
    const resolver = createResolver({ store, slack });

    const ctx = await resolver.resolveChannel(WORKSPACE, "C123");

    expect(store.channelUpserts[0]).toMatchObject({
      workspaceId: "ws_1",
      slackChannelId: "C123",
      name: "general",
      type: "channel",
      isBotMember: true,
      isPrivate: false,
    });
    expect(ctx).toEqual({
      id: "chan_1",
      workspaceId: "ws_1",
      slackChannelId: "C123",
      isBotMember: true,
      type: "channel",
    });
  });

  it("falls back to id-prefix inference when the bot can't see the channel (channel_not_found)", async () => {
    const store = new FakeStore();
    const slack = new FakeInfoGateway();
    slack.convInfo = null; // simulate channel_not_found
    const resolver = createResolver({ store, slack });

    const groupCtx = await resolver.resolveChannel(WORKSPACE, "G999");
    expect(groupCtx).toMatchObject({ type: "group", isBotMember: false });

    const dmCtx = await resolver.resolveChannel(WORKSPACE, "D999");
    expect(dmCtx).toMatchObject({ type: "im", isBotMember: false });
  });

  it("upserts a user with hydrated profile", async () => {
    const store = new FakeStore();
    const resolver = createResolver({ store, slack: new FakeInfoGateway() });

    const user = await resolver.resolveUser(WORKSPACE, "U42");

    expect(store.userUpserts[0]).toMatchObject({
      workspaceId: "ws_1",
      slackUserId: "U42",
      displayName: "Ada",
      avatarUrl: "http://img/ada.png",
    });
    expect(user.slackUserId).toBe("U42");
  });

  it("still upserts a user when the profile lookup returns nothing", async () => {
    const store = new FakeStore();
    const slack = new FakeInfoGateway();
    slack.profile = null;
    const resolver = createResolver({ store, slack });

    await resolver.resolveUser(WORKSPACE, "U42");
    expect(store.userUpserts[0]).toMatchObject({
      slackUserId: "U42",
      displayName: null,
      avatarUrl: null,
    });
  });
});
