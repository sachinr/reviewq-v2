import { NextFunction, Request, Response } from "express";

import { InteractiveMessageEvent } from "../entity/InteractiveMessageEvent";
import { verifySignature } from "../helpers/slackVerificationHelper";

export class InteractiveMessageController {

  public async interactiveMessage(request: Request, response: Response, next: NextFunction) {
    if (verifySignature(request)) {
      const payload = this.parseBody(request.body.payload);
      const interactiveMsg = new InteractiveMessageEvent(payload);
      if (interactiveMsg.findTeam()) {
        response.send("");
        switch (interactiveMsg.callback_id) {
          case "pagination":
            await interactiveMsg.paginate();
            break;
          case "complete_item":
            await interactiveMsg.completeItem();
            break;
          case "undo":
            await interactiveMsg.undoCompleteItem();
            break;
          case "message_action_add":
            await interactiveMsg.addItemAndNotify();
            break;

          default:
            break;
        }
      } else {
        response.sendStatus(500);
      }
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
