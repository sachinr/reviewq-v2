import { WebAPICallResult, WebClient } from "@slack/web-api";
import nodeFetch from "node-fetch";
import { BaseEntity, BeforeInsert, BeforeUpdate, Between, Column,
  Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { Item } from "./Item";
import { Message } from "./Message";
import { Team } from "./Team";

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
  public async fetchInfo(): Promise<void> {
    const client = new WebClient(this.team.botToken);
    try {
      const response = await client.conversations.info({ channel: this.slackId }) as IConversationInfoResult;
      if (response.ok) {
        this.name = response.channel.name_normalized;
        this.isExtShared = response.channel.is_ext_shared ? true : false;
        this.isGeneral = response.channel.is_general ? true : false;
        this.isMember = response.channel.is_member ? true : false;
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
    const dateThen = new Date(new Date().setMinutes(new Date().getMinutes() - 5));
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

  public async postError(errorMessage: string, url?: string) {
    const message = new Message(this).addErrorMessage(errorMessage).post(url);
  }

  public async postInfo(preText: string, url?: string) {
    const message = new Message(this);
    await message.addSummary(preText);
    if (!this.isMember) {
      message.addInvitePrompt();
    }
    await message.post(url);
  }

  public async postWelcomeMessage() {
    if ((await this.openItems()).length === 0) {
      const message = new Message(this, { text: "Hi! I can help you manage a list of tasks in this channel. Click the button below to learn more." });
      await message.post();
    }
  }

  public async postItemsList(start: number, reverse: boolean, url?: string) {
    if (start === -1) { return this.postInfo("", url); }
    const message = await new Message(this).addOpenItems(start, reverse);

    await message.post(url);
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

    const response = await client.reactions.add({
      channel: this.slackId,
      name: "white_check_mark",
      timestamp: ts,
    });
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
}
