import { BaseEntity, BeforeInsert, Column, CreateDateColumn,
  Entity, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";

import { WebAPICallResult, WebClient } from "@slack/web-api";
import { Channel } from "./Channel";
import { Event } from "./Event";
import { InteractiveMessageEvent } from "./InteractiveMessageEvent";
import { Message } from "./Message";
import { Team } from "./Team";
import { User } from "./User";

interface IChatPermalinkResult extends WebAPICallResult {
  channel: string;
  permalink: string;
}

@Entity()
@Unique(["channelId", "ts"])
export class Item extends BaseEntity {

  public static async createFromEvent(slackEvent: Event) {
    const cleanText = await Item.cleanMessage(slackEvent.event.text, slackEvent.user.teamId);

    if (cleanText.length === 0 && slackEvent.event.thread_ts) {
      const parentMessage = await slackEvent.channel.fetchMessage(slackEvent.event.thread_ts);
      const parentUser = await User.findOrCreateFromSlackId(parentMessage.user, slackEvent.eventTeam);

      let item = await Item.findOne({
        where: { channelId: slackEvent.channel.id, ts: parentMessage.ts },
      });

      if (item) {
        if (item.complete) {
          await item.markNotComplete();
          await item.save();
        }
      } else {
        item = new Item();
        item.user = parentUser;
        item.channel = slackEvent.channel;
        item.ts = slackEvent.event.ts;
        item.message = await Item.cleanMessage(parentMessage.text, parentMessage.channel.teamId);
        item.createdBy = slackEvent.user;
        if (parentMessage.files) {
          item.filesJSON = JSON.stringify(parentMessage.files);
        }

        await item.save();
      }

      return item;
    } else {
      let item = await Item.findOne({
        where: { channelId: slackEvent.channel.id, ts: slackEvent.event.ts },
      });

      if (item) {
        if (item.complete) {
          await item.markNotComplete();
          await item.save();
        }
      } else {
        item = new Item();
        item.user = slackEvent.user;
        item.channel = slackEvent.channel;
        item.ts = slackEvent.event.ts;
        item.message = cleanText;
        item.createdBy = slackEvent.user;
        if (slackEvent.event.files) {
          item.filesJSON = JSON.stringify(slackEvent.event.files);
        }

        await item.save();
      }

      return item;
    }
  }

  public static async createFromInteractiveMessage(slackEvent: InteractiveMessageEvent) {
    let item = await Item.findOne({
      where: { channelId: slackEvent.channel.id, ts: slackEvent.message.ts },
    });

    if (item) {
      if (item.complete) {
        await item.markNotComplete();
        await item.save();
      }
    } else {
      item = new Item();
      // tslint:disable-next-line: no-console
      console.log(slackEvent);
      item.createdBy = slackEvent.actionUser;
      item.user = slackEvent.messageUser;
      item.channel = slackEvent.channel;
      item.ts = slackEvent.message.ts;
      item.message = slackEvent.message.text;

      if (slackEvent.message.files) {
        item.filesJSON = JSON.stringify(slackEvent.message.files);
      }

      await item.save();
    }

    return item;
  }

  private static async cleanMessage(message: string, teamId: number) {
    const team = await Team.findOne(teamId);

    message = message.replace(/^(A|a)dd/, "");
    message = message.replace(`<@${team.botSlackId}> add`, "");
    message = message.replace(`<@${team.botSlackId}> Add`, "");
    message = message.replace(`<@${team.botSlackId}>`, "");
    message = message.trim();

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
  public completedById: number;

  @Column({ nullable: true })
  public createdById: number;

  @Column({ nullable: true })
  public dateCompleted: Date;

  @Column({ default: false })
  public vague: boolean;

  @Column({ nullable: true })
  public filesJSON: string;

  @ManyToOne((type) => User, (user) => user.items, { eager: true })
  public user: User;

  @ManyToOne((type) => Channel, (channel) => channel.items, { eager: true })
  public channel: Channel;

  @ManyToOne((type) => User, (user) => user.completedItems, { eager: true })
  public completedBy: User;

  @ManyToOne((type) => User, (user) => user.createdItems, { eager: true })
  public createdBy: User;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  @BeforeInsert()
  public async createArchiveLink() {
    if (!this.archiveLink) {
      if (!this.channel) {
        this.channel = await Channel.findOne(this.channelId);
      }
      const client = new WebClient(this.channel.team.botToken);
      const response = await client.chat.getPermalink({
        channel: this.channel.slackId,
        message_ts: this.ts,
      }) as IChatPermalinkResult;
      if (response.ok) {
        this.archiveLink = response.permalink;
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
    if (this.channel.isMember) {
      await this.channel.addReactionToMessage(this.ts);
    }

    return this;
  }

  public async markNotComplete() {
    this.complete = false;
    this.completedBy = null;
    this.dateCompleted = null;
    await this.save();
    this.channel.removeReactionFromMessage(this.ts);

    return this;
  }
}
