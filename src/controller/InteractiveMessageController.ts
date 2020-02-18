import { NextFunction, Request, Response } from "express";

import { InteractiveMessageEvent } from "../entity/InteractiveMessageEvent";
import { verifySignature } from "../helpers/slackVerificationHelper";

export class InteractiveMessageController {

  public async interactiveMessage(request: Request, response: Response, next: NextFunction) {
    try {
      if (verifySignature(request)) {
        const payload = this.parseBody(request.body.payload);
        // tslint:disable-next-line: no-console
        console.log(payload);
        const interactiveMsg = new InteractiveMessageEvent(payload);
        if (interactiveMsg.findTeams()) {
          response.send("");
          if (interactiveMsg.type === "block_actions") {
            switch (interactiveMsg.initiatingAction.value) {
              case "pagination":
                await interactiveMsg.paginate();
                break;
              case "complete_item":
                await interactiveMsg.completeItem();
                break;
              case "undo":
                await interactiveMsg.undoCompleteItem();
                break;
              case "view_all_modal":
                await interactiveMsg.openItemsModal();
                break;
              case "help":
                await interactiveMsg.openHelpModal();
                break;
              default:
                break;
            }
          } else {
            switch (interactiveMsg.callback_id) {
              case "top_level_actions":
                await interactiveMsg.topLevelActions();
                break;
              case "message_action_add":
                await interactiveMsg.addItemAndNotify();
                break;
              default:
                break;
            }
          }
        }
      }
    } catch (error) {
      next(error);
    }
  }

  private parseBody(jsonPayload: string) {
    const payload = JSON.parse(jsonPayload);
    payload.team_id = payload.team.id;
    payload.team = undefined;
    payload.channel_id = payload.channel?.id;
    payload.channel = undefined;
    payload.user_id = payload.user.id;
    payload.user = undefined;

    return payload;
  }
}
