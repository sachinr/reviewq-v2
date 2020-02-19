import { ActionsBlock, AttachmentAction, Block, MessageAttachment, SectionBlock } from "@slack/types";

import { ChatPostMessageArguments, WebClient } from "@slack/web-api";
import nodeFetch from "node-fetch";
import { Channel } from "./Channel";
import { ISlackFile } from "./Event";
import { Item } from "./Item";
import { View } from "./View";

export interface IPaginationInfo {
  items: Item[];
  start: number;
  end: number;
  totalItems: number;
  totalPages: number;
  currentPage: number;
  currentPageItems: Item[];
  reverse: boolean;
}

export interface IPaginationButton {
  text: string;
  start: number;
  reverse: boolean;
  channel?: string;
}

export interface ICompleteButton {
  itemId: number;
  itemTs: string;
  start: number;
  reverse: boolean;
  channel?: string;
}

export class Message {
  private static PRIMARY_COLOR = "#9469df";
  private static SECONDARY_COLOR = "#dbaaaa";
  private static ERROR_COLOR = "#DD3E1C";
  private static PER_PAGE = 3;

  // tslint:disable: variable-name
  // tslint:disable: object-literal-sort-keys
  public channel: Channel;
  public text: string;
  public as_user: boolean;
  public attachments?: MessageAttachment[];
  public files?: ISlackFile[];
  public blocks?: Block[];
  public icon_emoji?: string;
  public icon_url?: string;
  public link_names?: boolean;
  public mrkdwn?: boolean;
  public parse?: "full" | "none";
  public replace_original?: boolean;
  public reply_broadcast?: boolean;
  public thread_ts?: string;
  public ts: string;
  public unfurl_links?: boolean;
  public unfurl_media?: boolean;
  public user: string;
  public username?: string;
  public response_type?: "in_channel" | "ephemeral";

  constructor(channel: Channel, options?: object) {
    this.channel = channel;
    this.attachments = [];
    this.blocks = [];
    this.mrkdwn = true;
    if (options) {
      Object.assign(this, options);
    }
  }

  public addErrorMessage(text: string) {
    this.text = "Oops! Something went wrong.";
    this.attachments.push({
      color: Message.ERROR_COLOR,
      text,
      fallback: text,
      callback_id: "error_message",
    });
    return this;
  }

  public async addSummary(preText: string = "") {
    const count = (await this.channel.openItems()).length;
    const itemPluralized = count > 1 ? `are ${count} open items` : `is ${count} open item`;
    this.text = `There ${itemPluralized} in the queue`;
    this.text = preText.length > 0 ? `${preText}\n${this.text}` : this.text;
    const actions = [];
    if (count > 0) {
      actions.push({
        name: "All",
        text: "View all",
        type: "button",
        value: "all",
        style: "primary",
      });
    }

    actions.push({ name: "Help", text: "Help", type: "button", value: "help" });
    actions.push({ name: "Close", text: "Close", type: "button", value: "close" });

    this.attachments.push({
      actions: actions as AttachmentAction[],
      callback_id: "top_level_actions",
      color: Message.PRIMARY_COLOR,
      fallback: "FALLBACK",
    });

    this.replace_original = true;
    this.response_type = "in_channel";

    return this;
  }

  public async addInvitePrompt() {
    this.attachments.push({text: `*Tip*: Invite <@${this.channel.team.botSlackId}> to this channel to make it easier to manage your queue.`});
  }

  public async addItems(items: Item[], start: number, reverse: boolean, summaryText?: string) {
    const view = new View(this.channel);
    await view.addItems(items, start, reverse, summaryText);
    this.replace_original = true;

    this.text = summaryText;
    this.blocks = this.blocks.concat(view.blocks);

    return this;
  }

  public addHelpMessage() {
    const view = new View(this.channel);
    view.addHelp();
    this.blocks = view.blocks;
    return this;
  }

  public addWelcomeMessage() {
    this.blocks.push({
      type: "section",
      text: {
        text: "Hi! I can help you manage a list of tasks in this channel. Click the button below to learn more.",
        type: "mrkdwn",
      },
    } as SectionBlock);

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
    } as ActionsBlock);

    return this;
  }

  public async post(url?: string) {
    const args: any = Object.assign({}, this);
    args.channel = this.channel.slackId;
    if (url) {
      await nodeFetch(url, { method: "post", body: JSON.stringify(args) });
    } else {
      const client = new WebClient(this.channel.team.botToken);
      await client.chat.postMessage(args as ChatPostMessageArguments);
    }
  }

  private async getPaginationInfo(items: Item[], start: number, reverse: boolean) {
    const totalItems = items.length;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / Message.PER_PAGE) : 1;
    const currentPage = Math.ceil(start / Message.PER_PAGE);
    let currentPageItems: Item[] = [];

    let end = start + (Message.PER_PAGE - 1);
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

  private async buildMessageAttachment(items: Item[], start: number, reverse: boolean) {
    const paginationInfo = await this.getPaginationInfo(items, start, reverse);
    for (const currentItem of paginationInfo.currentPageItems) {
      const user = currentItem.user;
      const attachment = {
        author_name: user.fullName(),
        author_icon: user.avatar24,
        color: Message.SECONDARY_COLOR,
        text: currentItem.message,
        ts: currentItem.ts,
        fallback: "Mark as done",
        mrkdwn_in: ["text"],
      } as MessageAttachment;

      if (currentItem.filesJSON) {
        const files: ISlackFile[] = JSON.parse(currentItem.filesJSON);
        attachment.fields = [{
          title: "Files:",
          value: "",
          short: false,
        }];

        for (const file of files) {
          attachment.fields.push({
            title: "",
            value: `<${file.permalink}|${file.name || file.title}>`,
            short: false,
          });
        }
      }

      if (currentItem.complete) {
        attachment.callback_id = "undo";
        attachment.footer = `<${currentItem.archiveLink}|Archive link> | Completed by <@${currentItem.completedBy.slackId}>`;
        attachment.actions = [{
          name: "undo",
          text: ":arrow_right_hook: Undo",
          type: "button",
          value: JSON.stringify({ itemId: currentItem.id, itemTs: currentItem.ts, start, reverse } as ICompleteButton),
        }];
      } else {
        attachment.callback_id = "complete_item";
        attachment.footer = `<${currentItem.archiveLink}|Archive link>`;
        attachment.actions = [{
          name: "complete",
          text: ":pencil: Mark as done",
          type: "button",
          value: JSON.stringify({ itemId: currentItem.id, itemTs: currentItem.ts, start, reverse } as ICompleteButton),
        }];
      }

      this.attachments.push(attachment);
      }

    if (paginationInfo.totalItems > 0) {
      this.addPaginationButtons(paginationInfo);
    }

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
    if (pagination.start === 1 && pagination.totalItems > 1) {
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
