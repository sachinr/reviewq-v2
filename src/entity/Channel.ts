import { WebClient } from "@slack/web-api";
import { BaseEntity, Between, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { Item } from "./Item";
import { Message } from "./Message";
import { Team } from "./Team";

@Unique(["slackId", "teamId"])
@Entity()
export class Channel extends BaseEntity {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public slackId: string;

  @Column()
  public teamId: number;

  @ManyToOne((type) => Team, (team) => team.channels, { eager: true })
  public team: Team;

  @OneToMany((type) => Item, (item) => item.channel)
  public items: Item[];

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

  public async deleteMessage(ts: string): Promise<boolean> {
    const client = new WebClient((this.team).botToken);
    const result = await client.chat.delete({
      channel: this.slackId,
      ts,
    });

    return result.ok;
  }

  public async postError(error?: string) {
    const message = new Message(this).addErrorMessage().post();
  }

  public async postInfo(preText: string, url?: string) {
    const message = new Message(this);
    await message.addSummary(preText);
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

}
