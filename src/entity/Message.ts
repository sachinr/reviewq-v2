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
    if (options) {
      Object.assign(this, options);
    }
  }

  public addErrorMessage() {
    this.text = "Oops! Something went wrong.";
    return this;
  }

  public async addSummary(preText: string) {
    const count = (await this.channel.openItems()).length;
    const itemPluralized = count > 1 ? "items" : "item";
    this.text = `There are ${count} ${itemPluralized} in the queue`;
    this.text = preText.length > 0 ? `${preText}\n${this.text}` : this.text;

    this.addSummaryButtons();

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

  public async post(url?: string) {
    if (url) {
      const result = await nodeFetch(url, { method: "post", body: JSON.stringify(this.bodyArguments()) });
    } else {
      const client = new WebClient((await this.channel.team).botToken);
      const result = await client.chat.postMessage(this.bodyArguments() as ChatPostMessageArguments);
    }
  }

  private bodyArguments() {
    const args: any = this;
    args.channel = this.channel.slackId;

    return args;
  }

  private addSummaryButtons() {
   this.attachments.push({
     actions: [
       {
         name: "All",
         text: "View all",
         type: "button",
         value: "1",
       },
       {
         name: "Close",
         text: "Close",
         type: "button",
         value: "Close",
       },
     ],
     callback_id: "all/" + this.channel.slackId,
     color: Message.PRIMARY_COLOR,
     fallback: "FALLBACK",
   });

   this.replace_original = true;

   return this;
  }

  private async getPaginationInfo(start: number, reverse: boolean) {
    let openItems = await this.channel.openItems();
    openItems = reverse ? openItems.reverse() : openItems;

    const totalItems = openItems.length;
    const totalPages = Math.ceil(totalItems / Message.PER_PAGE);
    const currentPage = Math.ceil(start / Message.PER_PAGE);

    let end = start + (Message.PER_PAGE - 1);
    if (end > totalItems) {
      end = totalItems;
    }

    return {
      openItems,
      currentPage,
      end,
      start,
      totalItems,
      totalPages,
    } as IPaginationInfo;
  }

  private currentPageOpenItems(pagination: IPaginationInfo) {
    if (pagination.totalItems === 0) {
      return [];
    }

    return pagination.openItems.slice(pagination.start - 1, pagination.end);
  }

  private async buildMessageAttachment(start: number, reverse: boolean) {
    const paginationInfo = await this.getPaginationInfo(start, reverse);
    const pageItems = this.currentPageOpenItems(paginationInfo);
    for (const currentItem of pageItems) {
      const user = await currentItem.user;
      this.attachments.push({
        author_name: user.fullName(),
        author_icon: user.avatar24,
        color: Message.SECONDARY_COLOR,
        text: currentItem.message,
        footer: `<${currentItem.archiveLink}|Archive link>`,
        ts: currentItem.ts,
        fallback: "Mark as done",
        callback_id: "complete_item/" + this.channel.slackId + "/" + start.toString(),
        mrkdwn_in: ["text"],
        actions: [{
          name: "complete",
          text: ":pencil: Mark as done",
          type: "button",
          value: currentItem.ts,
        }],
      });
    }

    this.addPaginationButtons(paginationInfo);

    return this;
  }

  private addPaginationButtons(pagination: IPaginationInfo) {
    const buttons = [];
    if (pagination.end < pagination.totalItems) {
      buttons.push(["Next", pagination.end + 1, pagination.reverse]);
    }
    if (pagination.start > Message.PER_PAGE) {
      // tslint:disable-next-line: max-line-length
      buttons.push(["Previous", pagination.start - Message.PER_PAGE, pagination.reverse]);
    }
    buttons.push(["Minimize", -1, pagination.reverse]);
    if (pagination.start === 0) {
      buttons.push(["Sort", 0, !pagination.reverse]);
    }

    const actions: AttachmentAction[] = [];
    buttons.forEach((b) => {
      actions.push({
        name: b[0],
        text: b[0],
        type: "button",
        value: `${b[1]}/${b[2]}`,
      } as AttachmentAction);
    });

    this.attachments.push({
      actions,
      callback_id: "pagination/" + this.channel.slackId,
      color: Message.PRIMARY_COLOR,
      fallback: "Next/Previous",
      footer: `Page ${pagination.currentPage} of ${pagination.totalPages}`,
    });
  }
}
