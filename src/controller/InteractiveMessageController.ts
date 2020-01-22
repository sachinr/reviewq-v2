import { NextFunction, Request, Response } from "express";
import { InteractiveMessage } from "../entity/InteractiveMessage";

export class InteractiveMessageController {

  public async interactiveMessage(request: Request, response: Response, next: NextFunction) {
    const payload = this.parseBody(request.body.payload);
    let interactiveMessage: InteractiveMessage;
    interactiveMessage = Object.assign(new InteractiveMessage(), payload);
    if (interactiveMessage.findTeam()) {
      response.send("");
      interactiveMessage.process();
    } else {
      response.sendStatus(500);
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
