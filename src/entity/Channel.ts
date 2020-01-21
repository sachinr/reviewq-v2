import { ChatPostMessageArguments, WebClient } from "@slack/web-api";
import { BaseEntity, Column, Entity, getRepository, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { Item } from "./Item";
import { Team } from "./Team";

@Unique(["slackId", "teamId"])
@Entity()
export class Channel extends BaseEntity {
  private static PRIMARY_COLOR = "#9469df";

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

  public async postError(error?: string) {
    const client = new WebClient((await this.team).botToken);
    const result = await client.chat.postMessage({
      channel: this.slackId,
      text: "Oops! Something went wrong.",
    });
  }

  public async postInfo(info: string) {
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
    const client = new WebClient((await this.team).botToken);
    const result = await client.chat.postMessage(options as ChatPostMessageArguments);
  }
}
