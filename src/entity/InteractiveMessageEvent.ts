import { Block } from "@slack/web-api";

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

interface IInteractiveMessageMessage {
  type: string;
  text: string;
  user: string;
  ts: string;
  team: string;
  blocks: Block[];
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
  public message?: IInteractiveMessageMessage;
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
    if (this.actions) {
      this.initiatingAction = this.actions[0];
    } else {
      this.initiatingAction = { name: "Message Action", type: "Message Action", value: "Message Action" };
    }
  }

  public async findTeam(): Promise<Team> {
    if (!this.team) {
      const team = await Team.findOne({ where: { slackId: this.message?.team || this.team_id } });
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
        channel.team = this.team;
        await channel.save();
      }
      this.channel = channel;

      const userId = this.message?.user || this.user_id;

      let user = await User.findOne({ where: { slackId: userId } });

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

  public async addItemAndNotify() {
    await this.findOrCreateSlackObjects();
    const item = await Item.createFromInteractiveMessage(this);
    await item.channel.join();
    await item.notify("created", this.response_url);
  }

  public async completeItem() {
    await this.findOrCreateSlackObjects();
    const completionInfo = JSON.parse(this.initiatingAction.value) as ICompleteButton;
    // TODO: Verify that interactiveMessage can't be spoofed
    const item = await Item.findOne(completionInfo.itemId);
    await item.markComplete(this.user);
    await this.channel.postItemsList(completionInfo.start,
      completionInfo.reverse, this.response_url);
  }

  public async undoCompleteItem() {
    await this.findOrCreateSlackObjects();
    const completionInfo = JSON.parse(this.initiatingAction.value) as ICompleteButton;
    // TODO: Verify that interactiveMessage can't be spoofed
    const item = await Item.findOne(completionInfo.itemId);
    await item.markNotComplete();
    await this.channel.postItemsList(completionInfo.start,
      completionInfo.reverse, this.response_url);
    await this.channel.removeReactionFromMessage(completionInfo.itemTs);
  }

  public async paginate() {
    await this.findOrCreateSlackObjects();
    const paginationInfo = JSON.parse(this.initiatingAction.value) as IPaginationButton;
    if (paginationInfo.text.toLowerCase() === "close") {
      this.channel.deleteMessage(this.message_ts, this.response_url);
    } else {
      this.channel.postItemsList(paginationInfo.start,
        paginationInfo.reverse, this.response_url);
    }
  }

}
