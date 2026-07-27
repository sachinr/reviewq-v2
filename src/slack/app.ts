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
import { WebClient } from "@slack/web-api";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config";
import type { TokenCipher } from "../crypto/tokenCipher";
import { createPrismaItemRepository } from "../db/itemRepository";
import { createPrismaWorkspaceStore } from "../db/workspaceStore";
import { createPrismaAssistantStore } from "../db/assistantStore";
import { createItemService } from "../services/itemService";
import { createNotificationQueue } from "../jobs/bullNotificationQueue";
import { createTriageQueue, type TriageQueue } from "../jobs/bullTriageQueue";
import { createRedisConnection } from "../jobs/connection";
import { createAssistantService, createCannedResponder } from "../services/assistantService";
import { createAnthropicResponder } from "../services/anthropicResponder";
import { createAnthropicChat } from "./anthropicChat";
import { createAnthropicToolChat } from "./anthropicToolChat";
import {
  createToolResponder,
  defaultToolSystemPrompt,
  type ToolCallingChat,
} from "../services/toolLoop";
import type { MutationProposal, ToolExecContext } from "../services/assistantTools";
import type { ItemService } from "../services/itemService";
import { createResolver } from "./resolver";
import { SlackClient } from "./slackClient";
import { createSlackStreamSink, type StreamingChatClient } from "./slackStreamSink";
import { createInstallationStore } from "./installationStore";
import { renderQueue, ACTION_COMPLETE_ITEM, ACTION_UNDO_ITEM, ACTION_QUEUE_PAGE } from "./queueRenderer";
import { parseBotCommand } from "./messageCommands";
import type { ChannelContext, SourceMessage } from "../services/ports";
import type { Item } from "@prisma/client";
import {
  ACTION_ASSISTANT_CONFIRM,
  ACTION_ASSISTANT_DISMISS,
  ACTION_HELP,
  helpBlocks,
  homeView,
  invitePromptBlock,
  mutationConfirmBlocks,
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

  // Phase 3: the tool-calling brain. When a key is configured the assistant runs
  // the multi-turn tool-use loop (list a channel's queue, propose completing an
  // item) instead of the plain streaming responder; without one it stays on the
  // canned/streaming path above. The Anthropic client is built once here; the
  // per-request executor context (identity + channel access) is assembled in the
  // userMessage handler.
  const toolChat: ToolCallingChat | null = config.anthropicApiKey
    ? createAnthropicToolChat(config.anthropicApiKey)
    : null;

  const installationStore = createInstallationStore(prisma, cipher);

  // Outbound author-completion DMs go through BullMQ so a transient Slack failure
  // is retried by the worker rather than silently dropped (the classic app's
  // biggest structural gap). The queue opens its own Redis connection lazily.
  const notifier = createNotificationQueue(createRedisConnection(config.redisUrl));

  // Phase 2: enqueue an AI-triage job per newly-added item. Only when an API key
  // is configured (else there's no classifier and AI features are simply off, so
  // the classic queue works standalone). The 3-second ack window can't include an
  // LLM call, so this is fire-and-forget onto the queue after the item is created.
  const triageQueue: TriageQueue | null = config.anthropicApiKey
    ? createTriageQueue(createRedisConnection(config.redisUrl))
    : null;

  // Best-effort enqueue: a triage that never runs must not break the add itself,
  // so a Redis hiccup here is logged and swallowed rather than surfaced to Slack.
  async function enqueueTriage(workspaceId: string, itemId: string): Promise<void> {
    if (!triageQueue) return;
    try {
      await triageQueue.enqueueItem(workspaceId, itemId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`failed to enqueue triage for item ${itemId}`, err);
    }
  }

  const app = new App({
    signingSecret: config.slack.signingSecret,
    clientId: config.slack.clientId,
    clientSecret: config.slack.clientSecret,
    stateSecret: config.slack.stateSecret,
    scopes: config.slack.scopes,
    installationStore,
    // Request user scopes at install so the installer grants a user token — the
    // App Home uses it to list the channels that user belongs to.
    installerOptions: { directInstall: true, userScopes: config.slack.userScopes },
    logLevel: config.nodeEnv === "development" ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Build the per-request adapter bundle from the event's authed WebClient.
  function scopeFor(client: unknown) {
    const slack = new SlackClient(client as never);
    return {
      slack,
      resolver: createResolver({ store: workspaceStore, slack }),
      items: createItemService({ repo: itemRepo, slack, notifier }),
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
    const { all, annotations } = await items.openAndRecentlyClosedItems(channel, new Date());
    const { blocks } = renderQueue({ items: all, channelName: command.channel_name, annotations });

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

    if (!result.wasDuplicate) await enqueueTriage(workspace.id, result.item.id);

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
      const { all, annotations } = await items.openAndRecentlyClosedItems(channel, now);
      const { blocks } = renderQueue({ items: all, annotations });
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
      if (!result.wasDuplicate) await enqueueTriage(workspace.id, result.item.id);
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

    const { all, annotations } = await items.openAndRecentlyClosedItems(channel, new Date());
    const { blocks } = renderQueue({ items: all, page, annotations });
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

  // --- Assistant mutation confirmation -----------------------------------------
  // The trusted endpoint of the tool-calling flow: the assistant loop never
  // mutates; it renders a confirmation card, and only a click here — carrying the
  // real clicking user's identity — runs the mutation. The button value carries
  // only ids we set from thread context (never model text), and we re-resolve +
  // re-check channel ownership server-side (findItemInChannel + assertOwnership)
  // before touching anything, so a stale or cross-channel proposal is refused.
  app.action(ACTION_ASSISTANT_CONFIRM, async ({ ack, body, action, client, respond }) => {
    await ack();
    const v = parseMutationValue((action as { value?: string }).value);
    if (!v) return;
    const b = body as { team?: { id: string }; user?: { id: string } };
    const teamId = b.team?.id;
    const actorSlackId = b.user?.id;
    if (!teamId || !actorSlackId) return;

    const { resolver, items } = scopeFor(client);
    const workspace = await resolver.resolveWorkspace(teamId);
    if (!workspace) return;
    const channel = await resolver.resolveChannel(workspace, v.slackChannelId);
    const item = await items.findItemInChannel(v.itemId, channel);
    if (!item) {
      await respond({ replace_original: true, text: "That item is no longer available." });
      return;
    }
    const actor = await resolver.resolveUser(workspace, actorSlackId);
    try {
      if (v.kind === "complete") {
        await items.completeItem(item.id, channel, { userId: actor.id, slackId: actorSlackId }, new Date());
        await respond({ replace_original: true, text: ":white_check_mark: Marked that item as done." });
      } else {
        const res = await items.undoComplete(item.id, channel, new Date());
        await respond({
          replace_original: true,
          text: res.withinWindow
            ? ":leftwards_arrow_with_hook: Reopened that item."
            : "The undo window for that item has already passed.",
        });
      }
    } catch {
      await respond({ replace_original: true, text: "Sorry — I couldn't complete that action." });
    }
  });

  app.action(ACTION_ASSISTANT_DISMISS, async ({ ack, respond }) => {
    await ack();
    await respond({ replace_original: true, text: "Okay — I won't make that change." });
  });

  // --- App Home ----------------------------------------------------------------
  // Shows each channel the *viewing* user belongs to with its open-item count.
  // Membership is read from the user's own token (conversations.list), so the
  // home never leaks a private channel's queue to someone not in it — the plan's
  // authorization boundary. Without a stored user token we can't know membership,
  // so we render an auth prompt instead of a bogus/empty list (the old handler
  // mistakenly treated the user's U… id as a channel id and always came up empty).
  app.event("app_home_opened", async ({ event, client }) => {
    if (event.tab !== "home") return;
    const { resolver, items } = scopeFor(client);
    const teamId = (event as { view?: { team_id?: string } }).view?.team_id;
    let workspace = teamId ? await resolver.resolveWorkspace(teamId) : null;
    if (!workspace) {
      const auth = await (client as { auth: { test: () => Promise<{ team_id?: string }> } }).auth.test();
      workspace = auth.team_id ? await resolver.resolveWorkspace(auth.team_id) : null;
    }
    if (!workspace) return;

    const publish = (view: unknown) =>
      (client as { views: { publish: (a: unknown) => Promise<unknown> } }).views.publish({
        user_id: event.user,
        view,
      });

    const viewer = await resolver.resolveUser(workspace, event.user);
    if (!viewer.userTokenEncrypted) {
      await publish(homeView(config.appName, { kind: "authNeeded" }));
      return;
    }

    const memberIds = await listUserMemberChannelIds(cipher.decrypt(viewer.userTokenEncrypted));
    const channels = (await workspaceStore.listChannels(workspace.id)).filter((c) =>
      memberIds.has(c.slackChannelId),
    );
    const channelIds = channels.map((c) => c.id);
    const [counts, clarifyCounts] = await Promise.all([
      items.openCountsByChannels(channelIds),
      items.openClarificationCountsByChannels(channelIds),
    ]);
    const countById = new Map(counts.map((x) => [x.channelId, x.count]));
    const clarifyById = new Map(clarifyCounts.map((x) => [x.channelId, x.count]));
    const summaries = channels.map((c) => ({
      slackChannelId: c.slackChannelId,
      name: c.name,
      openCount: countById.get(c.id) ?? 0,
      clarificationCount: clarifyById.get(c.id) ?? 0,
    }));
    await publish(homeView(config.appName, { kind: "channels", channels: summaries }));
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

  // --- Assistant surface -------------------------------------------------------
  // Persists every turn so context survives across messages/restarts. The reply is
  // produced by whichever brain is configured: the Phase 3 tool-calling loop when
  // an API key is set (it can read a channel's queue and propose completing an item
  // via a confirmation card), otherwise the Phase 1/2 canned/streaming responder.
  // Either way the reply is rendered through the same live Slack stream sink.
  const assistant = new Assistant({
    threadStarted: async ({ say, saveThreadContext, setSuggestedPrompts }) => {
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
    userMessage: async ({ message, client, context, say, setStatus, getThreadContext }) => {
      const m = message as {
        text?: string;
        user?: string;
        channel?: string;
        thread_ts?: string;
        ts?: string;
      };
      const teamId = context.teamId;
      if (!teamId || !m.user || !m.channel || !m.text) return;

      const { resolver, items } = scopeFor(client);
      const workspace = await resolver.resolveWorkspace(teamId);
      if (!workspace) return;
      const appUser = await resolver.resolveUser(workspace, m.user);

      await setStatus("is thinking…");

      const threadTs = m.thread_ts ?? m.ts ?? "";
      const input = {
        workspaceId: workspace.id,
        appUserId: appUser.id,
        slackChannelId: m.channel,
        slackThreadTs: threadTs,
      };

      // Where the reply is rendered: the same live Slack stream sink both paths
      // use, so the final text always arrives via chat.startStream/appendStream/
      // stopStream (rate-safe) rather than one delayed block.
      const sink = createSlackStreamSink(client as StreamingChatClient, {
        channel: m.channel,
        threadTs,
      });

      try {
        if (toolChat) {
          // --- Tool-calling path -------------------------------------------------
          // Scope the assistant's reads to the channel this thread is *about* (the
          // one the user opened it from). That single membership fact — the user is
          // demonstrably in the channel they invoked the assistant from — is the
          // authorization boundary here, so we don't need a per-turn user-token
          // round-trip: any other channel is simply not accessible to the executor.
          const threadCtx = await safeGetThreadContext(getThreadContext);
          const contextChannelId = threadCtx?.channel_id;
          const contextChannel = contextChannelId
            ? await resolver.resolveChannel(workspace, contextChannelId)
            : null;

          const execCtx: ToolExecContext = {
            workspaceId: workspace.id,
            requestingSlackId: m.user,
            canAccessChannel: (id) => id === contextChannelId,
            resolveChannel: async (id) => (id === contextChannelId ? contextChannel : null),
            items,
          };
          const system = defaultToolSystemPrompt(config.appName, { currentChannelId: contextChannelId });
          const responder = createToolResponder(toolChat, execCtx, system);

          const { reply, proposals } = await assistantSvc.handleUserMessageWithTools(
            input,
            m.text,
            new Date(),
            responder,
          );
          await renderReply(sink, say, reply);

          // Turn each deferred mutation into a trusted confirmation card — but only
          // for an item that really belongs to the in-context channel and is in the
          // right state. A fabricated/cross-channel itemId (e.g. from injected
          // content) resolves to nothing here and silently produces no card.
          if (contextChannel) {
            for (const p of proposals) {
              await maybePostConfirmation(say, items, contextChannel, p);
            }
          }
        } else {
          // --- Canned / plain-streaming path (no API key) ------------------------
          const { reply } = await assistantSvc.handleUserMessageStreaming(input, m.text, new Date(), sink);
          if (!sink.started) await say(reply);
        }
      } finally {
        // Idempotent: closes a half-open stream if generation threw mid-flight.
        await sink.stop();
      }
    },
  });
  app.assistant(assistant);

  return app;
}

/**
 * The set of channel ids the token's owner is a member of, across every
 * conversation type, following pagination. Used to scope the App Home to only
 * the channels the viewing user can actually see.
 */
async function listUserMemberChannelIds(userToken: string): Promise<Set<string>> {
  const web = new WebClient(userToken);
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await web.conversations.list({
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of (res.channels ?? []) as Array<{ id?: string }>) {
      if (c.id) ids.add(c.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

/** A minimal say() shape — enough to post text and optional blocks into the thread. */
type SayLike = (msg: { text: string; blocks?: unknown[] }) => Promise<unknown>;

/** Read the assistant thread's saved context, tolerating an absent/erroring util. */
async function safeGetThreadContext(
  getThreadContext?: () => Promise<{ channel_id?: string } | undefined>,
): Promise<{ channel_id?: string } | undefined> {
  if (!getThreadContext) return undefined;
  try {
    return await getThreadContext();
  } catch {
    return undefined;
  }
}

/**
 * Render an assembled reply through the live stream sink (single append + stop),
 * falling back to a plain post if nothing streamed (e.g. an empty reply so the
 * stream never opened) so the user always sees something.
 */
async function renderReply(
  sink: { append(text: string): Promise<void>; stop(): Promise<void>; readonly started: boolean },
  say: SayLike,
  reply: string,
): Promise<void> {
  if (reply.length > 0) await sink.append(reply);
  await sink.stop();
  if (!sink.started) await say({ text: reply });
}

/**
 * Post a confirmation card for a deferred mutation — but only when the proposal
 * points at a real item in the in-context channel that is in the right state for
 * the action. A fabricated or cross-channel itemId (possibly injected via message
 * content) resolves to nothing and produces no card at all.
 */
async function maybePostConfirmation(
  say: SayLike,
  items: Pick<ItemService, "findItemInChannel">,
  channel: ChannelContext,
  proposal: MutationProposal,
): Promise<void> {
  const itemId = typeof proposal.input.itemId === "string" ? proposal.input.itemId : null;
  if (!itemId) return;
  const item = await items.findItemInChannel(itemId, channel);
  if (!item) return;

  const kind = proposal.toolName === "complete_item" ? "complete" : "undo";
  if (kind === "complete" && item.status !== "open") return; // already done
  if (kind === "undo" && item.status !== "complete") return; // nothing to reopen

  await say({
    text: kind === "complete" ? "Confirm completing this item?" : "Confirm reopening this item?",
    blocks: mutationConfirmBlocks({
      kind,
      itemId: item.id,
      slackChannelId: channel.slackChannelId,
      label: itemLabel(item),
    }),
  });
}

/** A short, single-line label for an item, for the confirmation card. */
function itemLabel(item: Item): string {
  const text = item.messageText?.trim();
  const label = text && text.length > 0 ? text : "(no message text)";
  const oneLine = label.replace(/\s+/g, " ");
  const clipped = oneLine.length > 140 ? `${oneLine.slice(0, 137)}…` : oneLine;
  return item.permalink ? `<${item.permalink}|${clipped}>` : clipped;
}

/** Parse an assistant confirmation button's JSON value; null on anything malformed. */
function parseMutationValue(
  value?: string,
): { kind: "complete" | "undo"; itemId: string; slackChannelId: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { kind?: unknown; itemId?: unknown; slackChannelId?: unknown };
    if (
      (v.kind === "complete" || v.kind === "undo") &&
      typeof v.itemId === "string" &&
      typeof v.slackChannelId === "string"
    ) {
      return { kind: v.kind, itemId: v.itemId, slackChannelId: v.slackChannelId };
    }
  } catch {
    // malformed value → treat as no-op
  }
  return null;
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
