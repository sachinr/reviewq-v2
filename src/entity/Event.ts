import { Channel } from "./Channel";
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

  public async findOrCreateSlackObjects() {
    const team = await Team.findOne({ where: { slackId: this.team_id } });
    if (team) {
      this.team = team;
      let channel = await Channel.findOne({
        where: { slackId: this.event.channel, teamId: team.id },
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
        await user.fetchProfile();
        await user.save();
      }
      this.user = user;
    }
    return this;
  }
}
