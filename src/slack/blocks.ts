// Block Kit builders for the non-list surfaces — welcome message, help, and App
// Home. The queue list itself is built by renderQueue (queueRenderer.ts); these
// wrap it with the surrounding chrome and carry over the copy from the classic
// app's Message/View entities so the product reads the same.

import type { KnownBlock } from "@slack/types";

export const ACTION_HELP = "help";
export const ACTION_VIEW_ALL = "view_all_modal";

// The assistant's confirmation card: the trusted UI a proposed mutation must pass
// through before it takes effect. The tool-use loop never executes a mutation —
// it hands back a proposal, which becomes one of these cards; only a click here,
// carrying the real user's identity, runs it.
export const ACTION_ASSISTANT_CONFIRM = "assistant_confirm_mutation";
export const ACTION_ASSISTANT_DISMISS = "assistant_dismiss_mutation";

/** A mutation the assistant is asking the user to confirm. */
export interface MutationConfirmation {
  kind: "complete" | "undo";
  itemId: string;
  /** The channel the item lives in — set by us from thread context, not the model. */
  slackChannelId: string;
  /** A short human label for the item (its text/permalink), already resolved. */
  label: string;
}

/**
 * Build the confirm/dismiss card for one proposed mutation. The button `value`
 * carries only ids we control (kind/itemId/channel) — never model-authored free
 * text — so the action handler re-resolves and re-checks ownership server-side.
 */
export function mutationConfirmBlocks(c: MutationConfirmation): KnownBlock[] {
  const verb = c.kind === "complete" ? "mark this item as done" : "reopen this item";
  const value = JSON.stringify({ kind: c.kind, itemId: c.itemId, slackChannelId: c.slackChannelId });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Do you want me to ${verb}?\n>${c.label}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: c.kind === "complete" ? "Mark as Done" : "Reopen" },
          style: "primary",
          action_id: ACTION_ASSISTANT_CONFIRM,
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: ACTION_ASSISTANT_DISMISS,
          value,
        },
      ],
    },
  ];
}

/**
 * The scheduled staleness digest posted into a channel: a header plus the model's
 * prose. `staleItems` drives the header count so the message reads as a nudge
 * ("3 items have been open a while") rather than an anonymous wall of text.
 */
export function digestBlocks(summaryText: string, staleItems: number): KnownBlock[] {
  const noun = staleItems === 1 ? "item has" : "items have";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:hourglass_flowing_sand: *Review queue digest* — ${staleItems} ${noun} been open a while:`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: summaryText } },
  ];
}

export function welcomeBlocks(): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "Hi! I can help you manage a list of tasks in this channel. " +
          "Use the *message action* on any message (the ⋮ menu → _Add to review queue_) to add it, " +
          "and run the slash command to see everything that's open.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Help" },
          action_id: ACTION_HELP,
        },
      ],
    },
  ];
}

export function invitePromptBlock(botUserId: string): KnownBlock {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*Tip*: Invite <@${botUserId}> to this channel to make it easier to manage your queue.`,
      },
    ],
  };
}

export function helpBlocks(appName: string): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `How ${appName} works` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "• *Add an item* — open the message ⋮ menu on any message and choose _Add to review queue_.\n" +
          "• *See the queue* — run the slash command in a channel, or open the App Home tab.\n" +
          "• *Complete an item* — hit *Mark as Done*. The original author gets a heads-up, and you have a minute to *Undo*.\n" +
          "• *Add me to a channel* to let me react ✅ on completed messages.",
      },
    },
  ];
}

/** One row of the App Home channel list: a channel the viewer belongs to. */
export interface HomeChannelSummary {
  slackChannelId: string;
  name: string | null;
  openCount: number;
  /** How many of the open items still have an unanswered clarifying question. */
  clarificationCount?: number;
}

/**
 * App Home state. The classic home used the *viewing* user's token to list the
 * channels they're in and showed each one's open count — so we can only populate
 * it once that user has granted a user token. Without one we render a prompt
 * instead of silently showing an empty (or, worse, cross-member) list.
 */
export type HomeState =
  | { kind: "channels"; channels: HomeChannelSummary[] }
  | { kind: "authNeeded" };

/**
 * App Home view: a header plus either the per-channel open-count list (only the
 * channels the viewer is a member of) or an auth prompt. Pure — the handler does
 * the token/Slack I/O and hands the resolved state here.
 */
export function homeView(appName: string, state: HomeState): {
  type: "home";
  blocks: KnownBlock[];
} {
  const header: KnownBlock = {
    type: "header",
    text: { type: "plain_text", text: appName },
  };

  if (state.kind === "authNeeded") {
    return {
      type: "home",
      blocks: [
        header,
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "Connect your account to see your channels' review queues here.\n\n" +
              "In the meantime you can always run the slash command in a channel, " +
              "or use the *Add to review queue* message action on any message.",
          },
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Help" }, action_id: ACTION_HELP },
          ],
        },
      ],
    };
  }

  const withOpen = state.channels.filter((c) => c.openCount > 0);
  const body: KnownBlock[] =
    withOpen.length === 0
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":sparkles: Your channels have no open review items. All clear!" },
          },
        ]
      : withOpen.map((c) => {
          const needsClarify = c.clarificationCount ?? 0;
          const clarifySuffix =
            needsClarify > 0 ? ` · :grey_question: ${needsClarify} need${needsClarify === 1 ? "s" : ""} clarification` : "";
          return {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: `*<#${c.slackChannelId}>* — ${c.openCount} open item${c.openCount === 1 ? "" : "s"}${clarifySuffix}`,
            },
          };
        });

  return {
    type: "home",
    blocks: [
      header,
      { type: "section", text: { type: "mrkdwn", text: "Here's where your review items stand:" } },
      { type: "divider" },
      ...body,
    ],
  };
}
