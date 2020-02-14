import { ActionsBlock, Block, Button, ContextBlock, DividerBlock, KnownBlock, PlainTextElement, SectionBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";

import { Channel } from "./Channel";
import { ISlackFile } from "./Event";
import { Item } from "./Item";
import { ICompleteButton, IPaginationButton, IPaginationInfo } from "./Message";
import { User } from "./User";

// tslint:disable: object-literal-sort-keys
export class View {
  private static PRIMARY_COLOR = "#9469df";
  private static SECONDARY_COLOR = "#dbaaaa";
  private static ERROR_COLOR = "#DD3E1C";
  private static PER_PAGE = 3;

  // tslint:disable: variable-name
  public blocks: Array<KnownBlock | Block>;
  public callback_id?: string;
  public block_id?: string;
  public clear_on_close?: boolean;
  public close?: PlainTextElement;
  public notify_on_close?: boolean;
  public private_metadata?: string;
  public submit?: PlainTextElement;
  public title?: PlainTextElement;
  public type: "home" | "modal";

  public channel: Channel;

  constructor(channel: Channel, options?: object) {
    this.channel = channel;
    this.blocks = [];
    if (options) {
      Object.assign(this, options);
    }
  }

  public async addItems(items: Item[], start: number, reverse: boolean, summaryText?: string) {
    const paginationInfo = await this.getPaginationInfo(items, start, reverse);

    this.blocks = [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: summaryText || "*Here are your items:*",
      },
    } as SectionBlock,
    {
      type: "divider",
    } as DividerBlock,
    ];

    this.buildItemBlocks(paginationInfo.currentPageItems, start, reverse);

    if (paginationInfo.totalItems > 0) {
      this.addPaginationButtons(paginationInfo);
    }

    return this;
  }

  public addHelp() {
    this.blocks = this.blocks.concat([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Turn messages into tasks _quickly_*\n${process.env.APP_NAME} is the easiest way to make sure requests and questions in a channel don't get forgotten.`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Why use ${process.env.APP_NAME}?*\n• It's really really simple. No complex workflows. No boards and burndown charts. Just a list of messages in a channel that need to be reviewed.\n• Useful for all sorts of teams - legal can keep track of contracts to review or engineering can keep track of PRs that need a +1.`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Get Started!*",
        },
      },
      {
        type: "image",
        title: {
          type: "plain_text",
          text: "image1",
          emoji: true,
        },
        image_url: "https://reviewed.herokuapp.com/app-action-message-pane.png",
        alt_text: "image1",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*:one: Use the _Add to ${process.env.APP_NAME}_ action.* If you want to keep track of a message, select \`Add to ${process.env.APP_NAME}\` in a message's context menu (click the three dots when hovering over it). If you don't see it, click "More message actions...".`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*:two: Use the \`/${process.env.SLASH_COMMAND_NAME}\` command*. Type \`/${process.env.SLASH_COMMAND_NAME}\` to see a list of messages that need to be reviewed in the current channel. Click 'Mark as Done' to remove a message from the queue and notify the author.`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:three: *Add @${process.env.BOT_NAME} to a channel* by typing \`/invite @${process.env.BOT_NAME}\` from the channel. Say any of the following to get started with the bot:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `• *@${process.env.BOT_NAME} add [text]* to add [text] to your queue\n• *@${process.env.BOT_NAME} add* in a thread to add the parent message to the queue\n• *@${process.env.BOT_NAME} list* to see existing messages in the channel queue`,
        },

      },
    ]);
    return this;
  }

  public addAuthLink() {
    this.blocks = this.blocks.concat([{
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `If you authorize ${process.env.APP_NAME} to see which channels you're part of, you'll be able to manage all your queues right here right now`,
      },
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        url: `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&user_scope=channels:read,groups:read,mpim:read,im:read`,
        text: {
          type: "plain_text",
          text: "Authorize",
        },
        style: "primary",
      }],
    }]);
  }

  public addAppHomeIntro(userSlackId: string) {
    this.blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Hi <@${userSlackId}>! Welcome to ${process.env.APP_NAME}*`,
      },
    });

    this.blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${process.env.APP_NAME} helps you turn Slack messages into tasks so you can make sure nothing slips through the cracks. Use it to make sure contracts, questions, pull requests, and much more get reviewed and responded to.`,
      },
    });

    this.blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Learn more",
          },
          value: "help",
          action_id: JSON.stringify({team: this.channel.team.slackId}),
        },
      ],
    });

    this.blocks.push({
      type: "context",
      elements: [
        {
          type: "image",
          image_url: "https://api.slack.com/img/blocks/bkb_template_images/placeholder.png",
          alt_text: "placeholder",
        },
      ],
    });

    return this;
  }

  public async addChannelsList(channels: Channel[], user: User) {
    const totals = { channels: 0, items: 0};

    this.blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Channels*",
      },
    });

    this.blocks.push({
      type: "divider",
    });

    for (const channel of channels) {
      const openItems = channel.items.filter((i) => !i.complete);
      if (openItems.length > 0) {
        totals.channels += 1;
        totals.items += openItems.length;

        if (channel.name === null) {
          await channel.fetchInfo(user);
          await channel.save();
        }

        let channelName = "";

        if (channel.isMember) {
          channelName = `<#${channel.slackId}>`;
        } else {
          channelName = channel.name ? `#${channel.name}` : `<@${channel.team.botSlackId}>`;
        }

        this.blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${channelName}* _${openItems.length} open items_`,
          },
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              text: "View all",
            },
            value: "view_all_modal",
            action_id: JSON.stringify({ channel: channel.slackId }),
          },
        });

        this.blocks.push({
          type: "divider",
        });
      }
    }
    if (totals.channels === 0) {
      this.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*There are no open items in the channels you're a member of*`,
        },
      });
    }

    return this;
  }

  public async buildItemBlocks(items: Item[], start: number = 1, reverse: boolean = false) {
    for (const item of items) {
      let contextString = `<!date^${item.ts.split(".")[0]}^{date} at {time}^${item.archiveLink}|Archive Link>`;

      const actionButton = {
        type: "button",
        text: {
          type: "plain_text",
          text: "Mark as Done",
          emoji: true,
        },
        style: "primary",
        action_id: JSON.stringify({ itemId: item.id, itemTs: item.ts,
          start, reverse, channel: this.channel.slackId } as ICompleteButton),
        value: "complete_item",
      } as Button;

      if (item.complete) {
        actionButton.action_id = JSON.stringify({ itemId: item.id, itemTs: item.ts,
          start, reverse, channel: this.channel.slackId } as ICompleteButton);
        contextString = contextString + ` | Completed by <@${item.completedBy.slackId}>`;
        actionButton.text.text = ":arrow_right_hook: Undo";
        actionButton.value = "undo";
        delete actionButton.style;
      }

      const itemBlocks: Block[] = [
        {
          type: "context",
          elements: [
            {
              type: "image",
              image_url: item.user.avatar24 || "https://ca.slack-edge.com/T0NA99EG1-USC651H5X-ge6065915aa8-72",
              alt_text: item.user.fullName(),
            },
            {
              type: "mrkdwn",
              text: `*${item.user.fullName()}* on ${contextString}`,
            },
          ],
        } as ContextBlock,
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${item.message}` || "`No message text`",
          },
        } as SectionBlock,
      ];

      if (item.filesJSON) {
        const files: ISlackFile[] = JSON.parse(item.filesJSON);
        let fileString = "*Files:*\n";

        for (const file of files) {
          fileString = fileString + `<${file.permalink}|${file.name || file.title}>\n`;
        }

        itemBlocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: fileString,
            },
          ],
        } as ContextBlock);
      }

      itemBlocks.push({
        type: "actions",
        elements: [
          actionButton,
        ],
      } as ActionsBlock);

      itemBlocks.push({
        type: "divider",
      } as DividerBlock);

      this.blocks = this.blocks.concat(itemBlocks);
    }
  }

  public async open(trigger_id: string) {
    const args = Object.assign({}, this);
    delete args.channel;
    const client = new WebClient(this.channel.team.botToken);
    try {
      const result = await client.views.open({
        trigger_id,
        view: args,
      });

      return result;
    } catch (err) {
      // tslint:disable-next-line: no-console
      console.log(JSON.stringify(args), err, err.data.response_metadata);
    }
  }

  public async publish(user: User) {
    const args = Object.assign({}, this);
    delete args.channel;
    args.type = "home";
    const client = new WebClient(this.channel.team.botToken);
    try {
      const result = await client.views.publish({
        view: args,
        user_id: user.slackId,
      });

      return result;
    } catch (err) {
      // tslint:disable-next-line: no-console
      console.log(JSON.stringify(args), err, err.data.response_metadata);
    }
  }

  public async update(viewId: string, triggerId: string) {
    const args = Object.assign({}, this);
    delete args.channel;
    args.type = "modal";
    const client = new WebClient(this.channel.team.botToken);
    try {
      const result = await client.views.update({
        view: args,
        view_id: viewId,
      });

      return result;
    } catch (err) {
      // tslint:disable-next-line: no-console
      console.log(JSON.stringify(args), err, err.data.response_metadata);
    }
  }

  private async getPaginationInfo(items: Item[], start: number, reverse: boolean) {
    const totalItems = items.length;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / View.PER_PAGE) : 1;
    const currentPage = Math.ceil(start / View.PER_PAGE);
    let currentPageItems: Item[] = [];

    let end = start + (View.PER_PAGE - 1);
    if (end > totalItems) {
      end = totalItems;
    }

    if (totalItems > 0) {
      currentPageItems = items.slice(start - 1, end);
    }

    return {
      items,
      currentPage,
      currentPageItems,
      end,
      start,
      totalItems,
      totalPages,
      reverse,
    } as IPaginationInfo;
  }

  private addPaginationButtons(pagination: IPaginationInfo) {
    const buttons: IPaginationButton[] = [];
    if (pagination.end < pagination.totalItems) {
      buttons.push({
        text: "Next",
        start: pagination.end + 1,
        reverse: pagination.reverse,
        channel: this.channel.slackId,
      });
    }
    if (pagination.start > View.PER_PAGE) {
      buttons.push({
        text: "Previous",
        start: pagination.start - View.PER_PAGE,
        reverse: pagination.reverse,
        channel: this.channel.slackId,
      });
    }
    if (this.type !== "modal") {
      buttons.push({ text: "Minimize", start: -1, reverse: pagination.reverse });
      if (pagination.start === 1 && pagination.totalItems > 1) {
        buttons.push({ text: "Sort", start: 1, reverse: !pagination.reverse });
      }
    }

    const elements: Button[]  = [];
    buttons.forEach((button) => {
      elements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: button.text,
          emoji: true,
        },
        action_id: JSON.stringify(button),
        value: "pagination",
      } as Button);
    });

    this.blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Page ${pagination.currentPage} of ${pagination.totalPages}`,
      }],
    } as ContextBlock);

    if (elements.length > 0) {
      this.blocks.push({
        type: "actions",
        elements,
      } as ActionsBlock);
    }

    return this;
  }
}
