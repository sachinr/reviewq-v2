// Bolt app assembly. This is the v2 replacement for the classic Express
// controllers (Command/Event/InteractiveMessage/OAuth): every Slack surface is
// registered here as a Bolt listener, and each listener does the same three
// things — resolve the workspace/channel/user from the payload, call the tested
// core (itemService / renderQueue), then reflect the result back to Slack.
//
// Per-request wiring: Bolt hands each listener a `client` (a WebClient already
// authed with the right workspace's bot token via the InstallationStore), so the
// Slack-touching adapters are built per request from that client while the
// Prisma-backed adapters are shared.

import { App, LogLevel } from "@slack/bolt";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config";
import type { TokenCipher } from "../crypto/tokenCipher";
import { createPrismaItemRepository } from "../db/itemRepository";
import { createPrismaWorkspaceStore } from "../db/workspaceStore";
import { createItemService } from "../services/itemService";
import { createResolver } from "./resolver";
import { SlackClient } from "./slackClient";
import { createInstallationStore } from "./installationStore";
import { renderQueue, ACTION_COMPLETE_ITEM, ACTION_UNDO_ITEM, ACTION_QUEUE_PAGE } from "./queueRenderer";
import {
  ACTION_HELP,
  helpBlocks,
  homeView,
  invitePromptBlock,
  welcomeBlocks,
} from "./blocks";

export const SHORTCUT_ADD_ITEM = "message_action_add";

export interface AppDeps {
  prisma: PrismaClient;
  cipher: TokenCipher;
  config: Config;
}

export function createApp({ prisma, cipher, config }: AppDeps): App {
  const itemRepo = createPrismaItemRepository(prisma);
  const workspaceStore = createPrismaWorkspaceStore(prisma);

  const app = new App({
    signingSecret: config.slack.signingSecret,
    clientId: config.slack.clientId,
    clientSecret: config.slack.clientSecret,
    stateSecret: config.slack.stateSecret,
    scopes: config.slack.scopes,
    installationStore: createInstallationStore(prisma, cipher),
    installerOptions: { directInstall: true },
    logLevel: config.nodeEnv === "development" ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Build the per-request adapter bundle from the event's authed WebClient.
  function scopeFor(client: unknown) {
    const slack = new SlackClient(client as never);
    return {
      slack,
      resolver: createResolver({ store: workspaceStore, slack }),
      items: createItemService({ repo: itemRepo, slack }),
    };
  }

  // --- Slash command: show the channel's queue ---------------------------------
  // A RegExp matches whatever command name the workspace configured, so we don't
  // hard-code a single slash. `private` keeps the classic ephemeral behavior.
  app.command(/.*/, async ({ command, ack, respond, client }) => {
    await ack();
    const { resolver, items } = scopeFor(client);
    const workspace = await resolver.resolveWorkspace(command.team_id);
    if (!workspace) return;

    const channel = await resolver.resolveChannel(workspace, command.channel_id);
    const { all } = await items.openAndRecentlyClosedItems(channel, new Date());
    const { blocks } = renderQueue({ items: all, channelName: command.channel_name });

    const finalBlocks = channel.isBotMember || channel.type === "im"
      ? blocks
      : [...blocks, invitePromptBlock(workspace.botUserId)];

    await respond({
      response_type: command.text?.trim() === "private" ? "ephemeral" : "in_channel",
      blocks: finalBlocks,
      text: "Your review queue",
    });
  });

  // --- Message action: add the acted-on message to the queue -------------------
  app.shortcut(SHORTCUT_ADD_ITEM, async ({ shortcut, ack, client }) => {
    await ack();
    if (shortcut.type !== "message_action") return;

    const { resolver, items } = scopeFor(client);
    const teamId = shortcut.team?.id;
    if (!teamId) return;
    const workspace = await resolver.resolveWorkspace(teamId);
    if (!workspace) return;

    const channel = await resolver.resolveChannel(workspace, shortcut.channel.id);
    const flagger = await resolver.resolveUser(workspace, shortcut.user.id);

    const msg = shortcut.message as {
      ts: string;
      text?: string;
      user?: string;
      bot_id?: string;
      thread_ts?: string;
      files?: unknown[];
    };

    // Human authors get an AppUser FK; bot/app authors keep only the raw id
    // (schema: authorUserId is null for them), matching the classic app.
    let authorUserId: string | null = null;
    if (msg.user) {
      authorUserId = (await resolver.resolveUser(workspace, msg.user)).id;
    }

    const result = await items.createItem(
      channel,
      {
        slackMessageTs: msg.ts,
        slackThreadTs: msg.thread_ts ?? null,
        messageText: msg.text ?? null,
        authorSlackId: msg.user ?? msg.bot_id ?? "unknown",
        authorUserId,
        filesJson: msg.files ? JSON.stringify(msg.files) : null,
      },
      flagger.id,
    );

    const confirm = result.wasDuplicate
      ? "That message is already in your review queue."
      : result.wasReopened
        ? ":recycle: Re-added a completed item to your queue."
        : ":inbox_tray: Added to your review queue.";

    await client.chat.postEphemeral({
      channel: shortcut.channel.id,
      user: shortcut.user.id,
      text: confirm,
    });
  });

  // --- Block actions: complete / undo / paginate -------------------------------
  app.action(ACTION_COMPLETE_ITEM, async ({ ack, body, action, client, respond }) => {
    await ack();
    await mutateAndRerender(body, client, respond, async ({ items, channel, actorSlackId, resolver, workspace }) => {
      const itemId = (action as { value: string }).value;
      const actor = await resolver.resolveUser(workspace, actorSlackId);
      await items.completeItem(itemId, channel, { userId: actor.id, slackId: actorSlackId }, new Date());
    });
  });

  app.action(ACTION_UNDO_ITEM, async ({ ack, body, action, client, respond }) => {
    await ack();
    await mutateAndRerender(body, client, respond, async ({ items, channel }) => {
      const itemId = (action as { value: string }).value;
      await items.undoComplete(itemId, channel, new Date());
    });
  });

  app.action(ACTION_QUEUE_PAGE, async ({ ack, body, action, client, respond }) => {
    await ack();
    const page = safePage((action as { value: string }).value);
    await mutateAndRerender(body, client, respond, async () => {}, page);
  });

  // Shared: run a mutation (or none), then re-render the queue in place.
  async function mutateAndRerender(
    body: unknown,
    client: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    respond: (args: any) => Promise<unknown>,
    mutate: (ctx: {
      items: ReturnType<typeof scopeFor>["items"];
      resolver: ReturnType<typeof scopeFor>["resolver"];
      channel: Awaited<ReturnType<ReturnType<typeof scopeFor>["resolver"]["resolveChannel"]>>;
      workspace: NonNullable<Awaited<ReturnType<ReturnType<typeof scopeFor>["resolver"]["resolveWorkspace"]>>>;
      actorSlackId: string;
    }) => Promise<void>,
    page = 1,
  ): Promise<void> {
    const b = body as {
      team?: { id: string };
      user?: { id: string };
      channel?: { id: string };
      response_url?: string;
    };
    const teamId = b.team?.id;
    const channelId = b.channel?.id;
    const actorSlackId = b.user?.id;
    if (!teamId || !channelId || !actorSlackId) return;

    const { resolver, items } = scopeFor(client);
    const workspace = await resolver.resolveWorkspace(teamId);
    if (!workspace) return;
    const channel = await resolver.resolveChannel(workspace, channelId);

    await mutate({ items, resolver, channel, workspace, actorSlackId });

    const { all } = await items.openAndRecentlyClosedItems(channel, new Date());
    const { blocks } = renderQueue({ items: all, page });
    await respond({ blocks, replace_original: true, text: "Your review queue" });
  }

  // --- Help button -------------------------------------------------------------
  app.action(ACTION_HELP, async ({ ack, client }) => {
    await ack();
    // Fire-and-forget: help is informational. Nothing to persist.
    void client;
  });

  // --- App Home ----------------------------------------------------------------
  app.event("app_home_opened", async ({ event, client }) => {
    if (event.tab !== "home") return;
    const { resolver, items } = scopeFor(client);
    const teamId = (event as { view?: { team_id?: string } }).view?.team_id;
    // app_home_opened carries the user; resolve the workspace from the authed
    // client's team via auth.test when the payload doesn't include a team id.
    let workspace = teamId ? await resolver.resolveWorkspace(teamId) : null;
    if (!workspace) {
      const auth = await (client as { auth: { test: () => Promise<{ team_id?: string }> } }).auth.test();
      workspace = auth.team_id ? await resolver.resolveWorkspace(auth.team_id) : null;
    }
    if (!workspace) return;

    // The home tab shows the user's DM queue (their own self-channel).
    const channel = await resolver.resolveChannel(workspace, event.user);
    const { all } = await items.openAndRecentlyClosedItems(channel, new Date());
    await (client as { views: { publish: (a: unknown) => Promise<unknown> } }).views.publish({
      user_id: event.user,
      view: homeView(config.appName, all),
    });
  });

  // --- Bot added to a channel: welcome message ---------------------------------
  app.event("member_joined_channel", async ({ event, client }) => {
    const { resolver, items } = scopeFor(client);
    const teamId = (event as { team?: string }).team;
    const workspace = teamId ? await resolver.resolveWorkspace(teamId) : null;
    if (!workspace) return;
    // Only greet when it's the bot itself that joined.
    if (event.user !== workspace.botUserId) return;

    const channel = await resolver.resolveChannel(workspace, event.channel);
    const open = await items.listOpenItems(channel);
    if (open.length > 0) return; // don't spam an already-active channel

    await client.chat.postMessage({
      channel: event.channel,
      text: "Thanks for adding me!",
      blocks: welcomeBlocks(),
    });
  });

  void helpBlocks; // referenced by the help modal in a later increment

  return app;
}

/** Parse a pagination button's JSON value, defaulting to page 1 on anything odd. */
function safePage(value: string): number {
  try {
    const n = Number(JSON.parse(value)?.page);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}
