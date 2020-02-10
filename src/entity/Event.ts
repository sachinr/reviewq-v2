import { Block } from "@slack/types";

import { Channel } from "./Channel";
import { Item } from "./Item";
import { Team } from "./Team";
import { User } from "./User";

  // tslint:disable: variable-name
export interface ISlackMessage {
  type: string;
  text: string;
  user: string;
  bot_id: string;
  ts: string;
  team: string;
  blocks: Block[];
  files?: ISlackFile[];
}

export interface ISlackFile {
  id: string;
  name: string;
  title: string;
  filetype: string;
  pretty_type: string;
  user: string;
  url_private: string;
  preview: string;
  permalink: string;
  thumb_pdf: string;
  url_private_download?: string;
}

interface ISlackEventBody extends ISlackMessage {
  subtype?: string;
  event_ts: string;
  channel: string;
  attachments?: ISlackEventAttachment[];
  thread_ts?: string;
}

interface ISlackEventAttachment {
  fallback: string;
  text: string;
  title: string;
  id: number;
  color: string;
  mrkdwn_in: string[];
  from_url: string;
  is_share: boolean;
}

export class Event {
  public team_id: string;
  public type: string;
  public authed_users: string[];
  public event_id: string;
  public event_time: number;
  public event: ISlackEventBody;
  public team: Team;
  public channel: Channel;
  public user: User;

  public async findTeam(): Promise<Team> {
    if (!this.team) {
      const team = await Team.findOne({ where: { slackId: this.team_id } });
      this.team = team;
    }

    return this.team;
  }

  public async findOrCreateSlackObjects(): Promise<Event> {
    if (await this.findTeam()) {
      let channel = await Channel.findOne({
        where: { slackId: this.event.channel, teamId: this.team.id },
      });

      if (!channel) {
        channel = new Channel();
        channel.slackId = this.event.channel;
        channel.team = this.team;
        await channel.save();
      }
      this.channel = channel;

      let user = await User.findOne({ where: { slackId: this.event.user } });

      if (!user) {
        user = new User();
        user.slackId = this.event.user;
        user.team = this.team;
        await user.fetchProfile();
        await user.save();
      }
      this.user = user;
    }
    return this;
  }

  public isMessageType() {
    if (this.event.type === "message") {
      if (!this.event.subtype) {
        return true;
      }
    }
    if (this.event.type === "app_mention") {
      return true;
    }

    return false;
  }

  public isMemberJoined() {
    return this.event.type === "member_joined_channel" && this.event.user === this.team.botSlackId;
  }

  public appHomeOpened() {
    return this.event.type === "app_home_opened";
  }

  public findUserCommand(): string {
    const loweredMessage = this.event.text.toLowerCase();
    const actionEntry = Object.entries(this.userCommands()).find((entry) => {
      return entry[1].test(loweredMessage);
    });
    if (actionEntry) {
      return actionEntry[0];
    } else {
      return "other";
    }
  }

  public async processMessageEvent() {
    if (await this.findTeam()) {
      if (this.event.user !== this.team.botSlackId) {
        await this.findOrCreateSlackObjects();
        switch (this.findUserCommand()) {
          case "directAdd":
            if (this.event.channel[0] === "D") {
              await this.addItemAndNotify();
            }
            break;
          case "atMentionAdd":
            await this.addItemAndNotify();
            break;
          case "directList":
            if (this.event.channel[0] === "D") {
              this.channel.postItemsList(1, false);
            }
            break;
          case "atMentionList":
            this.channel.postItemsList(1, false);
            break;
          case "atMentionHelp":
            this.channel.postHelpMessage();
            break;
          case "other":
            if (this.event.channel[0] === "D") {
              this.channel.postHelpMessage();
            }
          default:
            // Log weirdness
            break;
        }
      }
    }
  }

  private async addItemAndNotify() {
    const item = await Item.createFromEvent(this);
    await item.notify("created");
  }

  private userCommands() {
    return {
      atMentionAdd: new RegExp(`^<@${this.team.botSlackId.toLowerCase()}> add`),
      atMentionHelp: new RegExp(`^<@${this.team.botSlackId.toLowerCase()}> help`),
      atMentionList: new RegExp(`^<@${this.team.botSlackId.toLowerCase()}> list`),
      directAdd: /^add/,
      directList: /^list/,
    };
  }
}
