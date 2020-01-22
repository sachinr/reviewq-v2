import { WebClient } from "@slack/web-api";
import { BaseEntity, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { Item } from "./Item";
import { Message } from "./Message";
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
    const message = new Message(this).addErrorMessage().post();
  }

  public async postInfo(preText: string, url?: string) {
    const message = new Message(this);
    await message.addSummary(preText);
    await message.post(url);
  }

  public async postItemsList(start: number, reverse: boolean, url?: string) {
    if (start === -1) { return this.postInfo("", url); }
    const message = await new Message(this).addOpenItems(start, reverse);

    await message.post(url);
  }
}
