// Block Kit builders for the non-list surfaces — welcome message, help, and App
// Home. The queue list itself is built by renderQueue (queueRenderer.ts); these
// wrap it with the surrounding chrome and carry over the copy from the classic
// app's Message/View entities so the product reads the same.

import type { KnownBlock } from "@slack/types";
import type { Item } from "@prisma/client";
import { renderQueue } from "./queueRenderer";

export const ACTION_HELP = "help";
export const ACTION_VIEW_ALL = "view_all_modal";

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

/**
 * App Home: a header, then the rendered queue for the user's DM view. The
 * classic app published a per-user home; here we render whatever items list the
 * caller resolved (typically the user's DM/self channel queue).
 */
export function homeView(appName: string, items: Item[]): {
  type: "home";
  blocks: KnownBlock[];
} {
  const { blocks } = renderQueue({ items });
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: appName } },
      ...blocks,
    ],
  };
}
