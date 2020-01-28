import { BaseEntity, BeforeInsert, Column, CreateDateColumn,
  Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

import { WebAPICallResult, WebClient } from "@slack/web-api";
import { Channel } from "./Channel";
import { Event } from "./Event";
import { InteractiveMessageEvent } from "./InteractiveMessageEvent";
import { Message } from "./Message";
import { Team } from "./Team";
import { User } from "./User";

interface ITeamInfoResult extends WebAPICallResult {
  team: {
    id: string;
    name: string;
    domain: string;
    email_domain: string;
    icon: {
      image_34: string;
      image_44: string;
      image_68: string;
      image_88: string;
      image_102: string;
      image_132: string;
      image_230: string;
      image_original: string;
    };
  };
}

@Entity()
export class Item extends BaseEntity {

  public static async saveFromEvent(slackEvent: Event) {
    const item = new Item();
    item.user = slackEvent.user;
    item.channel = slackEvent.channel;
    item.ts = slackEvent.event.ts;
    item.message = slackEvent.event.text;
    await item.cleanMessage(slackEvent.user.teamId);
    await item.save();
    return item;
  }

  public static async saveFromInteractiveMessage(slackEvent: InteractiveMessageEvent) {
    const item = new Item();
    item.user = slackEvent.user;
    item.channel = slackEvent.channel;
    item.ts = slackEvent.message.ts;
    item.message = slackEvent.message.text;
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

  @ManyToOne((type) => User, (user) => user.items, { eager: true })
  public user: User;

  @ManyToOne((type) => Channel, (channel) => channel.items, { eager: true })
  public channel: Channel;

  @ManyToOne((type) => User, (user) => user.completedItems, { eager: true })
  public completedBy: User;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  @BeforeInsert()
  public async createArchiveLink() {
    if (!this.archiveLink) {
      const channel = await Channel.findOne(this.channelId);
      const client = new WebClient(channel.team.botToken);
      const response = await client.team.info() as ITeamInfoResult;
      if (response.ok) {
        const domain = response.team.domain;
        this.archiveLink = `https://${domain}.slack.com/archives/${channel.slackId}/p${this.ts.replace(".", "")}`;
      }
    }
  }

  public async notify(notificationType: "created" | "completed", url?: string) {
    switch (notificationType) {
      case "created":
        await (this.channel).postInfo("Item added! :white_check_mark:", url);
        break;
      case "completed":
        if (this.complete) {
          if (this.completedById !== this.userId) {
            const channel = new Channel();
            const itemUser = this.user;
            channel.slackId = itemUser.slackId;
            channel.team = await Team.findOne(this.user.teamId);
            await new Message(channel, {
              text: `${this.archiveLink} was marked as complete by <@${this.completedBy.slackId}>`,
            }).post(url);
          }
        }

        break;
    }
  }

  public async markComplete(completionUser: User) {
    this.complete = true;
    this.completedBy = completionUser;
    this.dateCompleted = new Date();
    await this.save();
    this.reload();
  }

  public async markNotComplete() {
    this.complete = false;
    this.completedBy = null;
    this.dateCompleted = null;
    await this.save();
    this.reload();
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
