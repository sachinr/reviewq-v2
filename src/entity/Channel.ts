import { ChatPostMessageArguments, WebClient } from "@slack/web-api";
import nodeFetch from "node-fetch";
import { BaseEntity, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { Item } from "./Item";
import { Team } from "./Team";

@Unique(["slackId", "teamId"])
@Entity()
export class Channel extends BaseEntity {
  private static PRIMARY_COLOR = "#9469df";
  private static SECONDARY_COLOR = "#dbaaaa";
  private static PER_PAGE = 3;

  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public slackId: string;

  @Column()
  public teamId: number;

  @ManyToOne((type) => Team, (team) => team.channels, { eager: true })
  public team: Promise<Team>;

  @OneToMany((type) => Item, (item) => item.channel)
  public items: Promise<Item[]>;

  public async openItems(): Promise<Item[]> {
    return await Item.find({ where: {channelId: this.id, complete: false }});
  }

  public async deleteMessage(ts: string): Promise<boolean> {
    const client = new WebClient((await this.team).botToken);
    const result = await client.chat.delete({
      channel: this.slackId,
      ts,
    });

    return result.ok;
  }

  public async postError(error?: string) {
    const client = new WebClient((await this.team).botToken);
    const result = await client.chat.postMessage({
      channel: this.slackId,
      text: "Oops! Something went wrong.",
    });
  }

  public async postInfo(info: string, url?: string) {
    const count = (await this.openItems()).length;
    const itemPluralized = count > 1 ? "items" : "item";
    const message = `${info}\nThere are ${count} ${itemPluralized} in the queue`;

    const options = {
      attachments: [{
        actions: [
          {
            name: "all",
            text: "View all",
            type: "button",
            value: "0",
          },
          {
            name: "close",
            text: "Close",
            type: "button",
            value: "close",
          },
        ],
        callback_id: "all/" + this.slackId,
        color: Channel.PRIMARY_COLOR,
        fallback: "FALLBACK",
      }],
      channel: this.slackId,
      replace_original: true,
      text: message,
    };

    if (url) {
      const result = await nodeFetch(url, { method: "post", body: JSON.stringify(options) });
    } else {
      const client = new WebClient((await this.team).botToken);
      const result = await client.chat.postMessage(options as ChatPostMessageArguments);
    }
  }

  public async postItemsList(index: number, reverse: boolean, url?: string) {
    if (index === -1) { this.postInfo("", url); }
    const attachments = await this.buildMessageAttachment(index, reverse);

    let message = "Here are your messages (oldest to newest)";

    if (attachments.length === 0) {
      message = "There are no messages in the queue";
    } else {
      if (reverse) {
        message = "Here are your messages (newest to oldest)";
      }
    }

    const options = {
      attachments,
      channel: this.slackId,
      replace_original: true,
      text: message,
      token: (await this.team).botToken,
    };

    if (url) {
      const result = await nodeFetch(url, { method: "post", body: JSON.stringify(options) });
    } else {
      const client = new WebClient((await this.team).botToken);
      const result = await client.chat.postMessage(options as ChatPostMessageArguments);
    }

  }

  private async buildMessageAttachment(first: number, reverse: boolean) {
    let openItems = await this.openItems();
    const count = openItems.length;
    const pages = Math.ceil(count / Channel.PER_PAGE);
    const currentPage = Math.ceil(first / Channel.PER_PAGE) + 1;

    if (count === 0) {
      return [];
    }

    let last = first + (Channel.PER_PAGE);
    if (last >= count) {
      last = count;
    }
    openItems = reverse ? openItems.reverse() : openItems;

    const attachments = [];

    const pageItems = openItems.slice(first, last);
    for (const currentItem of pageItems) {
      const user = await currentItem.user;
      attachments.push({
        author_name: user.fullName(),
        // tslint:disable-next-line: object-literal-sort-keys
        author_icon: user.avatar24,
        color: Channel.SECONDARY_COLOR,
        text: currentItem.message,
        footer: `<${currentItem.archiveLink}|Archive link>`,
        ts: currentItem.ts,
        fallback: "Mark as done",
        callback_id: "complete_item/" + this.slackId + "/" + first.toString(),
        mrkdwn_in: ["text"],
        actions: [{
          name: "complete",
          text: ":pencil: Mark as done",
          type: "button",
          value: currentItem.ts,
        }],
      });
    }

    const buttons = [];
    if (last !== count - 1) { buttons.push(["next", last + 1, reverse]); }
    if (first !== 0 ) { buttons.push(["previous", first - Channel.PER_PAGE, reverse]); }
    buttons.push(["minimize", -1, reverse]);
    if (first === 0) { buttons.push(["sort", 0, !reverse]); }

    const actions: object[] = [];
    buttons.forEach((b) => {
      actions.push({
        name: b[0],
        text: b[0].toString().charAt(0).toUpperCase() + b[0].toString().slice(1),
        type: "button",
        value: `${b[1]}/${b[2]}`,
      });
    });

    attachments.push({
      actions,
      callback_id: "pagination/" + this.slackId,
      color: Channel.PRIMARY_COLOR,
      fallback: "Next/Previous",
      footer: `Page ${currentPage} of ${pages}`,
    });

    return attachments;
  }
}
