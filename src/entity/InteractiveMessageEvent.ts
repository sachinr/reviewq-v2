import { In } from "typeorm";

import { Channel } from "./Channel";
import { ISlackMessage } from "./Event";
import { Item } from "./Item";
import { ICompleteButton, IPaginationButton } from "./Message";
import { Team } from "./Team";
import { User } from "./User";

// tslint:disable: variable-name
export interface IAction {
  name?: string;
  type: string;
  value: string;
  action_id?: string;
  block_id?: string;
  text?: {
    text: string;
  };
  action_ts?: string;
}

export class InteractiveMessageEvent {
  public type: string;
  public actions: IAction[];
  public callback_id?: string;
  public block_id?: string;
  public team_id: string;
  public channel_id: string;
  public user_id: string;
  public action_ts: string;
  public message_ts: string;
  public message?: ISlackMessage;
  public attachment_id: string;
  public is_app_unfurl: boolean;
  public response_url: string;
  public trigger_id: string;
  public view?: {
    id: string;
    type: string;
    root_view_id: string;
    hash: string;
  };
  public app_installed_team_id: string;

  public authedTeam: Team;
  public eventTeam: Team;
  public channel: Channel;
  public actionUser: User;
  public messageUser: User;
  public initiatingAction: IAction;

  public constructor(interactiveMessagePayload: object) {
    Object.assign(this, interactiveMessagePayload);
    if (this.actions) {
      this.initiatingAction = this.actions[0];
    } else {
      this.initiatingAction = { name: "Message Action", type: "Message Action", value: "Message Action" };
    }
  }

  public async findTeams(): Promise<Team> {
    if (!this.authedTeam) {
      const authedTeamSlackId = this.app_installed_team_id || this.team_id;
      this.authedTeam = await Team.findOne({ where: { slackId: authedTeamSlackId } });

      const eventSlackId = this.message?.team || this.team_id;
      if (eventSlackId !== this.app_installed_team_id) {
        this.eventTeam = await Team.findOne({ where: { slackId: eventSlackId }});
        if (!this.eventTeam) {
          this.eventTeam = new Team();
          this.eventTeam = await this.eventTeam.fetchInfo(eventSlackId, this.authedTeam.botToken);
        }
      } else {
        this.eventTeam = this.authedTeam;
      }
    }

    return this.authedTeam;
  }

  public async findOrCreateSlackObjects(): Promise<InteractiveMessageEvent> {
    if (await this.findTeams()) {
      if (this.channel_id) {
        let channel = await Channel.findOne({
          where: {
            slackId: this.channel_id,
          },
        });

        if (!channel) {
          channel = new Channel();
          channel.slackId = this.channel_id;
          channel.team = this.authedTeam;
          await channel.save();
        }
        this.channel = channel;
      } else {
        const actionId = JSON.parse(this.initiatingAction.action_id);
        if (actionId.channel) {
          this.channel = await Channel.findOne({
            where: {
              slackId: actionId.channel,
            },
          });
        }
      }

      const messageUserId = this.message?.user || this.message?.bot_id || this.user_id;
      this.messageUser = await User.findOne({ where: { slackId: messageUserId } });

      if (!this.messageUser) {
        this.messageUser = await User.findOrCreateFromSlackId(messageUserId, this.eventTeam);
      }

      if (messageUserId === this.user_id) {
        this.actionUser = this.messageUser;
      } else {
        this.actionUser = await User.findOrCreateFromSlackId(this.user_id, this.eventTeam);
      }
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
    const completionInfo = JSON.parse(this.initiatingAction.action_id) as ICompleteButton;
    // TODO: Verify that interactiveMessage can't be spoofed
    const item = await Item.findOne(completionInfo.itemId);
    await item.markComplete(this.actionUser);
    if (this.view?.type === "modal") {
      this.channel.updateItemsModal(completionInfo.start, completionInfo.reverse,
        this.view.id, this.trigger_id);
    } else {
      await this.channel.postItemsList(completionInfo.start,
        completionInfo.reverse, this.response_url);
    }
  }

  public async undoCompleteItem() {
    await this.findOrCreateSlackObjects();
    const completionInfo = JSON.parse(this.initiatingAction.action_id) as ICompleteButton;
    // TODO: Verify that interactiveMessage can't be spoofed
    const item = await Item.findOne(completionInfo.itemId);
    await item.markNotComplete();

    if (this.view?.type === "modal") {
      this.channel.updateItemsModal(completionInfo.start, completionInfo.reverse,
        this.view.id, this.trigger_id);
    } else {
      await this.channel.postItemsList(completionInfo.start,
        completionInfo.reverse, this.response_url);
    }
    await this.channel.removeReactionFromMessage(completionInfo.itemTs);
  }

  public async paginate() {
    await this.findOrCreateSlackObjects();
    const paginationInfo = JSON.parse(this.initiatingAction.action_id) as IPaginationButton;
    if (paginationInfo.text.toLowerCase() === "close") {
      this.channel.deleteMessage(this.message_ts, this.response_url);
    } else {
      if (this.view?.type === "modal") {
        this.channel.updateItemsModal(paginationInfo.start, paginationInfo.reverse,
          this.view.id, this.trigger_id);
      } else {
        this.channel.postItemsList(paginationInfo.start,
          paginationInfo.reverse, this.response_url);
      }
    }
  }

  public async topLevelActions() {
    await this.findOrCreateSlackObjects();
    switch (this.initiatingAction.name.toLowerCase()) {
      case "close":
        this.channel.deleteMessage(this.message_ts, this.response_url);
        break;
      case "all":
        this.channel.openItemsModal(this.trigger_id);
        break;
      case "help":
        this.channel.openHelpModal(this.trigger_id);
        break;
      default:
        break;
    }
  }

  public async openItemsModal() {
    await this.findOrCreateSlackObjects();
    this.channel.openItemsModal(this.trigger_id);
  }

  public async openHelpModal() {
    await this.findOrCreateSlackObjects();
    const channel = new Channel();
    channel.team = this.authedTeam;
    channel.openHelpModal(this.trigger_id);
  }
}
