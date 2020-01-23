import { NextFunction, Request, Response } from "express";

import { InteractiveMessageEvent } from "../entity/InteractiveMessageEvent";
import { Item } from "../entity/Item";
import { ICompleteButton, IPaginationButton } from "../entity/Message";

export class InteractiveMessageController {

  public async interactiveMessage(request: Request, response: Response, next: NextFunction) {
    const payload = this.parseBody(request.body.payload);
    const interactiveMsg = new InteractiveMessageEvent(payload);
    if (interactiveMsg.findTeam()) {
      response.send("");
      switch (interactiveMsg.callback_id) {
        case "pagination":
          await this.paginate(interactiveMsg);
          break;
        case "complete_item":
          await this.completeItem(interactiveMsg);
          break;
        case "vague":

        default:
          break;
      }
    } else {
      response.sendStatus(500);
    }
  }

  private async completeItem(interactiveMsg: InteractiveMessageEvent) {
    await interactiveMsg.findOrCreateSlackObjects();
    const completionInfo = JSON.parse(interactiveMsg.initiatingAction.value) as ICompleteButton;
    // TODO: Verify that interactiveMessage can't be spoofed
    const item = await Item.findOne(completionInfo.itemId);
    await item.markComplete(interactiveMsg.user);
    await interactiveMsg.channel.postItemsList(completionInfo.start,
      completionInfo.reverse, interactiveMsg.response_url);
    await interactiveMsg.channel.addReactionToMessage(completionInfo.itemTs);
  }

  private async paginate(interactiveMsg: InteractiveMessageEvent) {
    await interactiveMsg.findOrCreateSlackObjects();
    const paginationInfo = JSON.parse(interactiveMsg.initiatingAction.value) as IPaginationButton;
    if (paginationInfo.text === "Close") {
      interactiveMsg.channel.deleteMessage(interactiveMsg.message_ts);
    } else {
      interactiveMsg.channel.postItemsList(paginationInfo.start,
        paginationInfo.reverse, interactiveMsg.response_url);
    }
  }

  private parseBody(jsonPayload: string) {
    const payload = JSON.parse(jsonPayload);
    payload.team_id = payload.team.id;
    payload.team = undefined;
    payload.channel_id = payload.channel.id;
    payload.channel = undefined;
    payload.user_id = payload.user.id;
    payload.user = undefined;

    return payload;
  }
}
