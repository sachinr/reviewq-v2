import { Channel } from "./Channel";
import { Item } from "./Item";
import { Team } from "./Team";
import { User } from "./User";

  // tslint:disable: variable-name
interface ISlackEventBody {
  type: string;
  event_ts: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
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
        channel.teamId = this.team.id;
        await channel.save();
      }
      this.channel = channel;

      let user = await User.findOne({ where: { slackId: this.event.user } });

      if (!user) {
        user = new User();
        user.slackId = this.event.user;
        user.teamId = this.team.id;
        await user.fetchProfile();
        await user.save();
      }
      this.user = user;
    }
    return this;
  }

  public async process() {
    if (await this.findTeam()) {
      if (this.event.user !== this.team.botSlackId) {
        // tslint:disable-next-line: no-console
        console.log(this);
        await this.findOrCreateSlackObjects();
        if (this.type === "app_mention" || "message") {
          await this.processMessageEvent();
        }
      } else {
        // tslint:disable-next-line: no-console
        console.log("Ignore Bot's own events");
      }
    } else {
      throw new Error("No Team Found");
    }
  }

  private async processMessageEvent() {
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
          this.channel.postItemsList(0, false);
        }
        break;
      case "atMentionList":
        this.channel.postItemsList(0, false);
        break;
      case "other":
        if (this.event.channel[0] === "D") {
          // Send Help Text
        }
      default:
        // Log weirdness
        break;
    }
  }

  private async addItemAndNotify() {
    const item = Item.createFromEvent(this);
    await item.saveAndNotify();
  }

  private userCommands() {
    return {
      atMentionAdd: new RegExp(`^<@${this.team.botSlackId.toLowerCase()}> add`),
      atMentionList: new RegExp(`^<@${this.team.botSlackId.toLowerCase()}> list`),
      directAdd: /^add/,
      directList: /^list/,
    };
  }

  private findUserCommand(): string {
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
}
