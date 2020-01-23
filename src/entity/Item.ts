import { BaseEntity, Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

import { Channel } from "./Channel";
import { Event } from "./Event";
import { Message } from "./Message";
import { Team } from "./Team";
import { User } from "./User";

@Entity()
export class Item extends BaseEntity {

  public static async saveFromEvent(slackEvent: Event) {
    const item = new Item();
    item.userId = slackEvent.user.id;
    item.channelId = slackEvent.channel.id;
    item.ts = slackEvent.event.ts;
    item.message = slackEvent.event.text;
    await item.cleanMessage(slackEvent.user.teamId);
    await item.save();
    return item;
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
  public completedById: number;

  @Column({ nullable: true })
  public dateCompleted: Date;

  @Column({ default: false })
  public vague: boolean;

  @ManyToOne((type) => User, (user) => user.items)
  public user: Promise<User>;

  @ManyToOne((type) => Channel, (channel) => channel.items)
  public channel: Promise<Channel>;

  @ManyToOne((type) => User, (user) => user.completedItems)
  public completedBy: Promise<User>;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  public async notify(notificationType: "created" | "completed") {
    switch (notificationType) {
      case "created":
        await (await this.channel).postInfo("Item added! :white_check_mark:");
        break;
      case "completed":
        if (this.complete) {
          if (this.completedById !== this.userId) {
            const channel = new Channel();
            const itemUser = await this.user;
            channel.slackId = itemUser.slackId;
            channel.team = Promise.resolve((await this.user).team);
            await new Message(channel, {
              text: `${this.archiveLink} was marked as complete by <@${(await this.completedBy).slackId}>`,
            }).post();
          }
        }

        break;
    }
  }

  public async markComplete(completionUser: User) {
    this.complete = true;
    this.completedById = completionUser.id;
    this.dateCompleted = new Date();
  }

  private async cleanMessage(teamId: number) {
    const team = await Team.findOne(teamId);

    this.message = this.message.replace(/^(A|a)dd/, "");
    this.message = this.message.replace(`<@${team.botSlackId}> add`, "");
    this.message = this.message.replace(`<@${team.botSlackId}> Add`, "");
    this.message = this.message.replace(`<@${team.botSlackId}>`, "");
    this.message = this.message.trim();
  }

}
