import SlackTypes, { AttachmentAction } from "@slack/types";
import { ChatPostMessageArguments, WebClient } from "@slack/web-api";
import nodeFetch from "node-fetch";
import { Channel } from "./Channel";
import { Item } from "./Item";

interface IPaginationInfo {
  openItems: Item[];
  start: number;
  end: number;
  totalItems: number;
  totalPages: number;
  currentPage: number;
  currentPageOpenItems: Item[];
  reverse: boolean;
}

export interface IPaginationButton {
  text: string;
  start: number;
  reverse: boolean;
}

export interface ICompleteButton {
  itemId: number;
  itemTs: string;
  start: number;
  reverse: boolean;
}

export class Message {
  private static PRIMARY_COLOR = "#9469df";
  private static SECONDARY_COLOR = "#dbaaaa";
  private static PER_PAGE = 3;

  // tslint:disable: variable-name
  // tslint:disable: object-literal-sort-keys
  public channel: Channel;
  public text: string;
  public as_user: boolean;
  public attachments?: SlackTypes.MessageAttachment[];
  public blocks?: SlackTypes.Block[];
  public icon_emoji?: string;
  public icon_url?: string;
  public link_names?: boolean;
  public mrkdwn?: boolean;
  public parse?: "full" | "none";
  public replace_original?: boolean;
  public reply_broadcast?: boolean;
  public thread_ts?: string;
  public unfurl_links?: boolean;
  public unfurl_media?: boolean;
  public username?: string;

  constructor(channel: Channel, options?: object) {
    this.channel = channel;
    this.attachments = [];
    this.blocks = [];
    this.mrkdwn = true;
    if (options) {
      Object.assign(this, options);
    }
  }

  public addErrorMessage() {
    this.text = "Oops! Something went wrong.";
    return this;
  }

  public async addSummary(preText: string = "") {
    const count = (await this.channel.openItems()).length;
    const itemPluralized = count > 1 ? "items" : "item";
    this.text = `There are ${count} ${itemPluralized} in the queue`;
    this.text = preText.length > 0 ? `${preText}\n${this.text}` : this.text;

    this.attachments.push({
      actions: [
        {
          name: "All",
          text: "View all",
          type: "button",
          value: JSON.stringify({ text: "All", start: 1, reverse: false }),
        },
        {
          name: "Close",
          text: "Close",
          type: "button",
          value: JSON.stringify({ text: "Close" }),
        },
      ],
      callback_id: "pagination",
      color: Message.PRIMARY_COLOR,
      fallback: "FALLBACK",
    });

    this.replace_original = true;

    return this;
  }

  public async addOpenItems(start: number, reverse: boolean) {
    await this.buildMessageAttachment(start, reverse);
    this.replace_original = true;

    this.text = "Here are your messages (oldest to newest)";

    if (this.attachments.length === 0) {
      this.text = "There are no messages in the queue";
    } else {
      if (reverse) {
        this.text = "Here are your messages (newest to oldest)";
      }
    }

    return this;
  }

  public addHelpMessage() {
    this.attachments.push({
      mrkdwn_in: ["text"],
      fallback: "Required plain-text summary of the attachment.",
      color: Message.PRIMARY_COLOR,
      title: "ReviewQ lets you build a queue of messages to review in a channel",
      text: "ReviewQ is a way to manage a queue of work within the context of a channel. For example, a legal team might queue up messages requesting them to review contracts. Software development team might queue up Pull Requests that need to be reviewed.\n\n :arrow_right: To get started, invite *@reviewq* to a channel.",
    });

    this.attachments.push({
      color: Message.SECONDARY_COLOR,
      author_name: "Usage",
      mrkdwn_in: ["text", "fields"],
      fields: [
        {
          title: ":one: Add text to the queue",
          value: "`@reviewq add [text to add]`",
          short: true,
        },
        {
          title: ":two: Show queue for a channel",
          value: "`@reviewq list`",
          short: true,
        },
        {
          title: ":three: Add a message to the queue",
          value: "<https://get.slack.help/hc/en-us/articles/203274767-Share-messages-in-Slack|Share the message> and comment with `@reviewq add`",
          short: true,
        },
        {
          title: ":four: Add a file to the queue",
          value: "Leave a comment (not title!) with `@reviewq add` to an existing or new file",
          short: true,
        },
      ],
    });

    return this;
  }

  public async post(url?: string) {
    const args: any = Object.assign({}, this);
    args.channel = this.channel.slackId;

    if (url) {
      const result = await nodeFetch(url, { method: "post", body: JSON.stringify(args) });
    } else {
      const client = new WebClient((await this.channel.team).botToken);
      const result = await client.chat.postMessage(args as ChatPostMessageArguments);
    }
  }

  private async getPaginationInfo(start: number, reverse: boolean) {
    let openItems = await this.channel.openItems();
    openItems = reverse ? openItems.reverse() : openItems;

    const totalItems = openItems.length;
    const totalPages = Math.ceil(totalItems / Message.PER_PAGE);
    const currentPage = Math.ceil(start / Message.PER_PAGE);
    let currentPageOpenItems: Item[] = [];

    let end = start + (Message.PER_PAGE - 1);
    if (end > totalItems) {
      end = totalItems;
    }

    if (totalItems > 0) {
      currentPageOpenItems = openItems.slice(start - 1, end);
    }

    return {
      openItems,
      currentPage,
      currentPageOpenItems,
      end,
      start,
      totalItems,
      totalPages,
      reverse,
    } as IPaginationInfo;
  }

  private async buildMessageAttachment(start: number, reverse: boolean) {
    const paginationInfo = await this.getPaginationInfo(start, reverse);
    for (const currentItem of paginationInfo.currentPageOpenItems) {
      const user = await currentItem.user;
      this.attachments.push({
        author_name: user.fullName(),
        author_icon: user.avatar24,
        color: Message.SECONDARY_COLOR,
        text: currentItem.message,
        footer: `<${currentItem.archiveLink}|Archive link>`,
        ts: currentItem.ts,
        fallback: "Mark as done",
        callback_id: "complete_item",
        mrkdwn_in: ["text"],
        actions: [{
          name: "complete",
          text: ":pencil: Mark as done",
          type: "button",
          value: JSON.stringify({ itemId: currentItem.id, itemTs: currentItem.ts, start, reverse } as ICompleteButton),
        }],
      });
    }

    this.addPaginationButtons(paginationInfo);

    return this;
  }

  private addPaginationButtons(pagination: IPaginationInfo) {
    const buttons: IPaginationButton[] = [];
    if (pagination.end < pagination.totalItems) {
      buttons.push({text: "Next", start: pagination.end + 1, reverse: pagination.reverse});
    }
    if (pagination.start > Message.PER_PAGE) {
      buttons.push({text: "Previous", start: pagination.start - Message.PER_PAGE, reverse: pagination.reverse});
    }
    buttons.push({ text: "Minimize", start: -1, reverse: pagination.reverse });
    if (pagination.start === 1) {
      buttons.push({ text: "Sort", start: 1, reverse: !pagination.reverse });
    }

    const actions: AttachmentAction[] = [];
    buttons.forEach((button) => {
      actions.push({
        name: button.text,
        text: button.text,
        type: "button",
        value: JSON.stringify(button),
      } as AttachmentAction);
    });

    this.attachments.push({
      actions,
      callback_id: "pagination",
      color: Message.PRIMARY_COLOR,
      fallback: "Next/Previous",
      footer: `Page ${pagination.currentPage} of ${pagination.totalPages}`,
    });
  }
}
