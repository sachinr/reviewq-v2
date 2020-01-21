import { BaseEntity, Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { Channel } from "./Channel";
import { Event } from "./Event";
import { User } from "./User";

@Entity()
export class Item extends BaseEntity {

  public static createFromEvent(slackEvent: Event) {
    const item = new Item();
    item.userId = slackEvent.user.id;
    item.channelId = slackEvent.channel.id;
    item.ts = slackEvent.event.ts;
    item.message = Item.cleanMessage(slackEvent.event.text);
    return item;
  }

  private static cleanMessage(message: string) {
    message = message.replace("<@#{bot_slack_id}> add", "");
    message = message.replace("<@#{bot_slack_id}>", "");
    return message;
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public channelId: number;

  @Column()
  public userId: number;

  @Column()
  public ts: string;

  @Column({ nullable: true })
  public message: string;

  @Column({ nullable: true })
  public archiveLink: string;

  @Column({ default: false })
  public complete: boolean;

  @Column({ nullable: true })
  public dateCompleted: number;

  @Column({ nullable: true })
  public completedBy: string;

  @Column({ default: false })
  public vague: boolean;

  @ManyToOne((type) => User, (user) => user.items)
  public user: Promise<User>;

  @ManyToOne((type) => Channel, (channel) => channel.items)
  public channel: Promise<Channel>;

  public async saveAndNotify() {
    // try {
      await this.save();
      await (await this.channel).postInfo("Item added! :white_check_mark:");
    // } catch (error) {
      // await this.channel.postError();
    // }
  }
}
