import { Channel } from "./Channel";
import { Team } from "./Team";
import { User } from "./User";

// tslint:disable: variable-name
interface IAction {
  name: string;
  type: string;
  value: string;
}

export class InteractiveMessageEvent {
  public type: string;
  public actions: IAction[];
  public callback_id: string;
  public team_id: string;
  public channel_id: string;
  public user_id: string;
  public action_ts: string;
  public message_ts: string;
  public attachment_id: string;
  public is_app_unfurl: boolean;
  public response_url: string;
  public trigger_id: string;

  public team: Team;
  public channel: Channel;
  public user: User;
  public initiatingAction: IAction;

  public constructor(interactiveMessagePayload: object) {
    Object.assign(this, interactiveMessagePayload);
    this.initiatingAction = this.actions[0];
  }

  public async findTeam(): Promise<Team> {
    if (!this.team) {
      const team = await Team.findOne({ where: { slackId: this.team_id } });
      this.team = team;
    }

    return this.team;
  }

  public async findOrCreateSlackObjects(): Promise<InteractiveMessageEvent> {
    if (await this.findTeam()) {
      let channel = await Channel.findOne({
        where: { slackId: this.channel_id, teamId: this.team.id },
      });

      if (!channel) {
        channel = new Channel();
        channel.slackId = this.channel_id;
        channel.teamId = this.team.id;
        await channel.save();
      }
      this.channel = channel;

      let user = await User.findOne({ where: { slackId: this.user_id } });

      if (!user) {
        user = new User();
        user.slackId = this.user_id;
        user.teamId = this.team.id;
        await user.fetchProfile();
        await user.save();
      }
      this.user = user;
    }
    return this;
  }
}
