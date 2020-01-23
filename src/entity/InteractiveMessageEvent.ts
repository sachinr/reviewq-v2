import { getRepository } from "typeorm";
import { Channel } from "./Channel";
import { Item } from "./Item";
import { ICompleteButton, IPaginationButton } from "./Message";
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

  public async process() {
    if (await this.findTeam()) {
      switch (this.callback_id) {
        case "pagination":
          await this.findOrCreateSlackObjects();
          const paginationInfo = JSON.parse(this.initiatingAction.value) as IPaginationButton;
          if (paginationInfo.text === "Close") {
            this.channel.deleteMessage(this.message_ts);
          } else {
            this.channel.postItemsList(paginationInfo.start, paginationInfo.reverse, this.response_url);
          }
          break;
        case "complete_item":
          await this.findOrCreateSlackObjects();
          const completionInfo = JSON.parse(this.initiatingAction.value) as ICompleteButton;
          const item = await getRepository(Item).findOne({
            where: { channelId: this.channel.id, ts: completionInfo.ts },
          });
          item.markComplete(this.user);
          await item.save();
          await this.channel.postItemsList(completionInfo.start, completionInfo.reverse, this.response_url);
          break;
        case "vague":

        default:
          break;
      }

    } else {
      throw new Error("No Team Found");
    }
  }

}
