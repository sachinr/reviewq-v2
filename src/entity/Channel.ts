import { WebAPICallResult, WebClient } from "@slack/web-api";
import nodeFetch from "node-fetch";
import { BaseEntity, BeforeInsert, BeforeUpdate, Between, Column,
  Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { ISlackMessage } from "./Event";
import { Item } from "./Item";
import { Message } from "./Message";
import { Team } from "./Team";
import { User } from "./User";
import { View } from "./View";

interface IConversationInfoResult extends WebAPICallResult {
  channel: {
    id: string;
    name?: string;
    is_channel: boolean;
    is_group: boolean;
    is_im: boolean;
    created: number;
    creator: string;
    is_archived: boolean;
    is_general: boolean;
    name_normalized?: string;
    is_read_only: boolean;
    is_shared: boolean;
    parent_conversation?: string;
    is_ext_shared: boolean;
    is_org_shared: boolean;
    is_member: boolean;
    is_private: boolean;
    is_mpim: boolean;
  };
}

interface IReactionGetResult extends WebAPICallResult {
  type: string;
  channel: string;
  message: ISlackMessage;
}

@Unique(["slackId", "teamId"])
@Entity()
export class Channel extends BaseEntity {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public slackId: string;

  @Column()
  public teamId: number;

  @Column({ nullable: true })
  public name: string;

  @Column()
  public type: "channel" | "group" | "mpim" | "im";

  @Column({ default: false })
  public isGeneral: boolean;

  @Column({ default: false })
  public isReadOnly: boolean;

  @Column({ default: false })
  public isShared: boolean;

  @Column({ default: false })
  public isExtShared: boolean;

  @Column({ default: false })
  public isOrgShared: boolean;

  @Column({ default: false })
  public isMember: boolean;

  @Column({ default: false })
  public isPrivate: boolean;

  @ManyToOne((type) => Team, (team) => team.channels, { eager: true })
  public team: Team;

  @OneToMany((type) => Item, (item) => item.channel)
  public items: Item[];

  @BeforeUpdate()
  @BeforeInsert()
  public async fetchInfo(user?: User): Promise<void> {
    let client = new WebClient(this.team.botToken);
    if (user && user.token) {
      client = new WebClient(user.token);
    }

    try {
      const response = await client.conversations.info({ channel: this.slackId }) as IConversationInfoResult;
      if (response.ok) {
        this.name = response.channel.name_normalized;
        this.isExtShared = response.channel.is_ext_shared ? true : false;
        this.isGeneral = response.channel.is_general ? true : false;
        if (!user) {
          this.isMember = response.channel.is_member ? true : false;
        }
        this.isOrgShared = response.channel.is_org_shared ? true : false;
        this.isPrivate = response.channel.is_private ? true : false;
        this.isReadOnly = response.channel.is_read_only ? true : false;
        this.isShared = response.channel.is_shared ? true : false;
        if (response.channel.is_channel || response.channel.is_group) {
          this.type = response.channel.is_private ? "group" : "channel";
        } else {
          this.type = response.channel.is_im ? "im" : "mpim";
        }
      }
    } catch (error) {
      if (error.data.error === "channel_not_found") {
        this.isMember = false;
        if (this.slackId[0] === "G") {
          this.type = "group";
        } else { this.type = "im"; }
      }
    }
  }

  public async openItems(): Promise<Item[]> {
    return await Item.find({
      order: { id: "ASC" },
      where: { channelId: this.id, complete: false },
    });
  }

  public async recentlyClosed(): Promise<Item[]> {
    const dateNow = new Date();
    const dateThen = new Date(new Date().setMinutes(new Date().getMinutes() - 1));
    const findOperator = Between(dateThen, dateNow);
    return await Item.find({
      where: {
        dateCompleted: findOperator,
      },
    });
  }

  public async deleteMessage(ts: string, url?: string): Promise<boolean> {
    if (!url) {
      const client = new WebClient((this.team).botToken);
      const result = await client.chat.delete({
        channel: this.slackId,
        ts,
      });
      return result.ok;
    } else {
      const result = await nodeFetch(url, { method: "post", body: JSON.stringify({ delete_original: true }) });
      return result.ok;
    }
  }

  public async openNewItemModal(triggerId: string) {
    const client = new WebClient((this.team).botToken);
    const view = new View(this);
    view.addNewItemForm();
    const result = await view.open(triggerId);
    return result.ok;
  }

  public async postError(errorMessage: string, url?: string) {
    const message = new Message(this).addErrorMessage(errorMessage).post(url);
  }

  public async postInfo(preText: string, url?: string) {
    const message = new Message(this);
    await message.addSummary(preText);
    if (!this.isMember && this.type !== "im") {
      message.addInvitePrompt();
    }
    await message.post(url);
  }

  public async postWelcomeMessage() {
    if ((await this.openItems()).length === 0) {
      const message = new Message(this);
      message.addWelcomeMessage();
      await message.post();
    }
  }

  public async openAndRecentlyClosedItems() {
    const openItems = await this.openItems();
    const closedItems = await this.recentlyClosed();

    let items = (openItems).concat(closedItems);
    items = items.sort((a, b) => {
      return a.id <= b.id ? -1 : 1;
    });

    return { open: openItems, recentlyCompleted: closedItems, all: items };
  }

  public async postItemsList(start: number, reverse: boolean, url?: string) {
    if (start === -1) { return this.postInfo("", url); }

    const itemObj = await this.openAndRecentlyClosedItems();
    itemObj.all = reverse ? itemObj.all.reverse() : itemObj.all;

    let summaryText = "*There are no items in your queue.*";
    if (itemObj.all.length > 0 ) {
      if (itemObj.open.length > 0) {
        summaryText = "*Here are the open items in your queue*";
      } else {
        if (itemObj.recentlyCompleted.length > 0) {
          summaryText = "*Here are the recently completed in your queue*";
        }
      }
      summaryText = reverse ? summaryText + " (newest to oldest): " : summaryText + " (oldest to newest)";
      const message = await new Message(this).addItems(itemObj.all, start, reverse, summaryText);
      await message.post(url);
    } else {
      this.postInfo("", url);
    }
  }

  public async postHelpMessage() {
    let message = new Message(this);
    message.addHelpMessage();
    await message.post();

    if ((await this.openItems()).length > 0) {
      message = new Message(this);
      await message.addSummary();
      message.post();
    }
  }

  public async addReactionToMessage(ts: string) {
    const client = new WebClient(this.team.botToken);

    try {
      const response = await client.reactions.add({
        channel: this.slackId,
        name: "white_check_mark",
        timestamp: ts,
      });
    } catch (error) {
      // tslint:disable-next-line: no-console
      console.log(error);
    }
  }

  public async removeReactionFromMessage(ts: string) {
    const client = new WebClient(this.team.botToken);

    const response = await client.reactions.remove({
      channel: this.slackId,
      name: "white_check_mark",
      timestamp: ts,
    });
  }

  public async join() {
    const client = new WebClient(this.team.botToken);

    if (!this.isMember && this.type === "channel") {
      const response = await client.conversations.join({
      channel: this.slackId,
      });
    }
  }

  public async fetchMessage(ts: string): Promise<Message> {
    const client = new WebClient(this.team.botToken);
    const response = await client.reactions.get({
      channel: this.slackId,
      timestamp: ts,
    }) as IReactionGetResult;
    if (response.ok) {
      return new Message(this, response.message);
    }
  }

  public async openItemsModal(triggerId: string) {
    const view = new View(this, { type: "modal", title: { type: "plain_text", text: this.name }});
    const items = (await this.openAndRecentlyClosedItems()).all;
    await view.addItems(items, 1, false);
    await view.open(triggerId);
  }

  public async updateItemsModal(start: number, reverse: boolean, viewId: string, triggerId: string) {
    const view = new View(this, { type: "modal", title: { type: "plain_text", text: this.name }});
    const items = (await this.openAndRecentlyClosedItems()).all;
    await view.addItems(items, start, reverse);
    await view.update(viewId, triggerId);
  }

  public async openHelpModal(triggerId: string) {
    const view = new View(this, { type: "modal", title: { type: "plain_text", text: "ReviewQ" }});
    await view.addHelp().open(triggerId);
  }
}
