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

import { App, Assistant, LogLevel } from "@slack/bolt";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config";
import type { TokenCipher } from "../crypto/tokenCipher";
import { createPrismaItemRepository } from "../db/itemRepository";
import { createPrismaWorkspaceStore } from "../db/workspaceStore";
import { createPrismaAssistantStore } from "../db/assistantStore";
import { createItemService } from "../services/itemService";
import { createAssistantService, createCannedResponder } from "../services/assistantService";
import { createAnthropicResponder } from "../services/anthropicResponder";
import { createAnthropicChat } from "./anthropicChat";
import { createResolver } from "./resolver";
import { SlackClient } from "./slackClient";
import { createSlackStreamSink, type StreamingChatClient } from "./slackStreamSink";
import { createInstallationStore } from "./installationStore";
import { renderQueue, ACTION_COMPLETE_ITEM, ACTION_UNDO_ITEM, ACTION_QUEUE_PAGE } from "./queueRenderer";
import { parseBotCommand } from "./messageCommands";
import type { SourceMessage } from "../services/ports";
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
  // Phase 2: use the Anthropic-backed responder when a key is configured, else
  // fall back to the canned Phase 1 stand-in so the app still boots without one.
  const responder = config.anthropicApiKey
    ? createAnthropicResponder({
        chat: createAnthropicChat(config.anthropicApiKey),
        appName: config.appName,
      })
    : createCannedResponder(config.appName);
  const assistantSvc = createAssistantService({
    store: createPrismaAssistantStore(prisma),
    responder,
  });

  const installationStore = createInstallationStore(prisma, cipher);

  const app = new App({
    signingSecret: config.slack.signingSecret,
    clientId: config.slack.clientId,
    clientSecret: config.slack.clientSecret,
    stateSecret: config.slack.stateSecret,
    scopes: config.slack.scopes,
    installationStore,
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

  // --- Classic text entry points: @bot add/done/list/help and DM add/list ------
  // The third add path (alongside the message action and slash command). A pure
  // parser (messageCommands.ts) decides the command; this handler does the I/O:
  // resolve rows, optionally fetch the parent message (a `@bot add` thread reply
  // adds the parent), mutate via itemService, and confirm.
  interface TextCtx {
    text: string;
    userSlackId: string;
    channelId: string;
    ts: string;
    threadTs?: string;
    isDM: boolean;
  }

  async function handleTextCommand(client: unknown, teamId: string | undefined, ctx: TextCtx): Promise<void> {
    if (!teamId || !ctx.text || !ctx.userSlackId) return;
    const { resolver, items, slack } = scopeFor(client);
    const workspace = await resolver.resolveWorkspace(teamId);
    if (!workspace) return;
    // Never react to our own messages (guards against loops).
    if (ctx.userSlackId === workspace.botUserId) return;

    const cmd = parseBotCommand(ctx.text, workspace.botUserId, ctx.isDM);
    if (cmd.kind === "ignore") return;

    const channel = await resolver.resolveChannel(workspace, ctx.channelId);
    const now = new Date();

    if (cmd.kind === "help") {
      await reply(client, ctx, { text: "Here's how I work", blocks: helpBlocks(config.appName) });
      return;
    }

    if (cmd.kind === "list") {
      const { all } = await items.openAndRecentlyClosedItems(channel, now);
      const { blocks } = renderQueue({ items: all });
      await reply(client, ctx, { text: "Your review queue", blocks });
      return;
    }

    if (cmd.kind === "add") {
      const flagger = await resolver.resolveUser(workspace, ctx.userSlackId);
      // Empty body + a thread reply means "add the message I'm replying to";
      // otherwise the command message itself becomes the item.
      let source: SourceMessage | null;
      if (cmd.body.length === 0 && ctx.threadTs && ctx.threadTs !== ctx.ts) {
        source = await sourceFromParent(slack, resolver, workspace, channel.slackChannelId, ctx.threadTs);
      } else {
        source = {
          slackMessageTs: ctx.ts,
          slackThreadTs: ctx.threadTs ?? null,
          messageText: cmd.body.length > 0 ? cmd.body : null,
          authorSlackId: ctx.userSlackId,
          authorUserId: flagger.id,
          filesJson: null,
        };
      }
      if (!source) {
        await reply(client, ctx, { text: "Sorry — I couldn't find that message to add." });
        return;
      }
      const result = await items.createItem(channel, source, flagger.id);
      await reply(client, ctx, {
        text: result.wasDuplicate
          ? "That message is already in your review queue."
          : result.wasReopened
            ? ":recycle: Re-added a completed item to your queue."
            : ":inbox_tray: Added to your review queue.",
      });
      return;
    }

    // cmd.kind === "done": complete the parent (thread reply) or this message.
    const targetTs = ctx.threadTs && ctx.threadTs !== ctx.ts ? ctx.threadTs : ctx.ts;
    const actor = await resolver.resolveUser(workspace, ctx.userSlackId);
    const done = await items.completeItemByMessageTs(
      channel,
      targetTs,
      { userId: actor.id, slackId: ctx.userSlackId },
      now,
    );
    await reply(client, ctx, {
      text: done
        ? ":white_check_mark: Marked as done."
        : "I couldn't find an open item for that message.",
    });
  }

  // Resolve a parent message into an add-ready SourceMessage (bot authors keep a
  // raw id with a null FK, mirroring the message-action path).
  async function sourceFromParent(
    slack: ReturnType<typeof scopeFor>["slack"],
    resolver: ReturnType<typeof scopeFor>["resolver"],
    workspace: NonNullable<Awaited<ReturnType<ReturnType<typeof scopeFor>["resolver"]["resolveWorkspace"]>>>,
    slackChannelId: string,
    parentTs: string,
  ): Promise<SourceMessage | null> {
    const parent = await slack.getMessage(slackChannelId, parentTs);
    if (!parent) return null;
    let authorUserId: string | null = null;
    if (parent.user) authorUserId = (await resolver.resolveUser(workspace, parent.user)).id;
    return {
      slackMessageTs: parent.ts,
      slackThreadTs: parent.threadTs ?? null,
      messageText: parent.text,
      authorSlackId: parent.user ?? parent.botId ?? "unknown",
      authorUserId,
      filesJson: parent.filesJson ?? null,
    };
  }

  // Confirm back to the user: a plain post in a DM, an ephemeral in a channel so
  // we don't clutter it. Best-effort — a failed confirmation must not throw.
  async function reply(
    client: unknown,
    ctx: TextCtx,
    msg: { text: string; blocks?: unknown[] },
  ): Promise<void> {
    const chat = (client as {
      chat: {
        postMessage: (a: unknown) => Promise<unknown>;
        postEphemeral: (a: unknown) => Promise<unknown>;
      };
    }).chat;
    try {
      if (ctx.isDM) {
        await chat.postMessage({ channel: ctx.channelId, text: msg.text, ...(msg.blocks ? { blocks: msg.blocks } : {}) });
      } else {
        await chat.postEphemeral({
          channel: ctx.channelId,
          user: ctx.userSlackId,
          text: msg.text,
          ...(msg.blocks ? { blocks: msg.blocks } : {}),
        });
      }
    } catch {
      // e.g. not_in_channel for an ephemeral: nothing we can do, don't crash.
    }
  }

  // DM messages: bare `add`/`list`, anything else → help. Channel messages are
  // handled via app_mention (below), so we only take im here — this also avoids
  // double-processing a channel message that also fired app_mention.
  app.message(async ({ message, context, client }) => {
    const m = message as {
      subtype?: string;
      channel_type?: string;
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
    };
    if (m.subtype || m.channel_type !== "im" || !m.text || !m.user || !m.channel || !m.ts) return;
    await handleTextCommand(client, context.teamId, {
      text: m.text,
      userSlackId: m.user,
      channelId: m.channel,
      ts: m.ts,
      threadTs: m.thread_ts,
      isDM: true,
    });
  });

  // Channel mentions: `@bot add/done/list/help`.
  app.event("app_mention", async ({ event, context, client }) => {
    const e = event as {
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
    };
    if (!e.text || !e.user || !e.channel || !e.ts) return;
    await handleTextCommand(client, context.teamId, {
      text: e.text,
      userSlackId: e.user,
      channelId: e.channel,
      ts: e.ts,
      threadTs: e.thread_ts,
      isDM: e.channel.startsWith("D"),
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
  // Rendered on the welcome message; replies with the help blocks in place
  // (ephemeral via the button's response_url) instead of the old no-op.
  app.action(ACTION_HELP, async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: "ephemeral",
      replace_original: false,
      text: "Here's how I work",
      blocks: helpBlocks(config.appName),
    });
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

  // --- Uninstall / token revocation --------------------------------------------
  // Slack fires app_uninstalled when the app is removed and tokens_revoked when a
  // user revokes. Either way the stored bot token is dead, so mark the workspace
  // inactive (fetchInstallation then refuses it) instead of leaving a stale,
  // decryptable token that would 401 on every future event.
  async function recordUninstall(context: {
    teamId?: string;
    enterpriseId?: string;
    isEnterpriseInstall?: boolean;
  }): Promise<void> {
    await installationStore.deleteInstallation?.({
      teamId: context.teamId,
      enterpriseId: context.enterpriseId,
      isEnterpriseInstall: context.isEnterpriseInstall ?? false,
    } as never);
  }
  app.event("app_uninstalled", async ({ context }) => {
    await recordUninstall(context);
  });
  app.event("tokens_revoked", async ({ context }) => {
    await recordUninstall(context);
  });

  // --- Assistant surface (Phase 1 skeleton) ------------------------------------
  // Persists every turn so context survives across messages/restarts; replies via
  // the injected Responder (canned now, Anthropic-backed in Phase 2).
  const assistant = new Assistant({
    threadStarted: async ({ event, say, saveThreadContext, setSuggestedPrompts }) => {
      await say(
        `Hi! I'm the ${config.appName} assistant. Ask me about your review queue, ` +
          `or use the message action on any message to add it.`,
      );
      await saveThreadContext();
      try {
        await setSuggestedPrompts({
          title: "Try asking",
          prompts: [
            { title: "What's in my queue?", message: "What's in my review queue?" },
            { title: "How do I add an item?", message: "How do I add an item to my queue?" },
          ],
        });
      } catch {
        // setSuggestedPrompts is best-effort; a failure here must not drop the thread.
      }
    },
    userMessage: async ({ message, client, context, say, setStatus }) => {
      const m = message as {
        text?: string;
        user?: string;
        channel?: string;
        thread_ts?: string;
        ts?: string;
      };
      const teamId = context.teamId;
      if (!teamId || !m.user || !m.channel || !m.text) return;

      const { resolver } = scopeFor(client);
      const workspace = await resolver.resolveWorkspace(teamId);
      if (!workspace) return;
      const appUser = await resolver.resolveUser(workspace, m.user);

      await setStatus("is thinking…");

      // Stream the reply into the thread live via chat.startStream/appendStream/
      // stopStream, so tokens render incrementally and rate-safely instead of
      // landing as one delayed block. The assembled reply is still persisted.
      const threadTs = m.thread_ts ?? m.ts ?? "";
      const sink = createSlackStreamSink(client as StreamingChatClient, {
        channel: m.channel,
        threadTs,
      });
      try {
        const { reply } = await assistantSvc.handleUserMessageStreaming(
          {
            workspaceId: workspace.id,
            appUserId: appUser.id,
            slackChannelId: m.channel,
            slackThreadTs: threadTs,
          },
          m.text,
          new Date(),
          sink,
        );
        // If the model produced nothing, the stream never opened — fall back to a
        // plain post so the user still sees a reply.
        if (!sink.started) await say(reply);
      } finally {
        // Idempotent: closes a half-open stream if generation threw mid-flight.
        await sink.stop();
      }
    },
  });
  app.assistant(assistant);

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
