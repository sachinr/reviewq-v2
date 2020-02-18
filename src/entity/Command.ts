import { Channel } from "./Channel";
import { Team } from "./Team";
import { User } from "./User";

// tslint:disable: variable-name
export class Command {
  public channel_id: string;
  public channel_name: string;
  public command: string;
  public response_url: string;
  public team_domain: string;
  public team_id: string;
  public text: string;
  public trigger_id: string;
  public user_id: string;
  public user_name: string;

  public channel: Channel;
  public team: Team;
  public user: User;

  public async findTeam(): Promise<Team> {
    if (!this.team) {
      const team = await Team.findOne({ where: { slackId: this.team_id } });
      this.team = team;
    }

    return this.team;
  }

  public async findOrCreateSlackObjects(): Promise<Command> {
    if (await this.findTeam()) {
      let channel = await Channel.findOne({
        where: {
          slackId: this.channel_id,
        },
      });

      if (!channel) {
        channel = new Channel();
        channel.slackId = this.channel_id;
        channel.team = this.team;
        await channel.save();
      }
      this.channel = channel;

      let user = await User.findOne({ where: { slackId: this.user_id } });

      if (!user) {
        user = new User();
        user.slackId = this.user_id;
        user.team = this.team;
        await user.fetchProfile();
        await user.save();
      }
      this.user = user;
    }
    return this;
  }
}
