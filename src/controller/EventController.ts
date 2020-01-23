import { NextFunction, Request, Response } from "express";
import { Event } from "../entity/Event";

export class EventController {
  public async event(request: Request, response: Response, next: NextFunction) {
    if (request.body.type === "url_verification") {
      response.send({ challenge: request.body.challenge });
    } else if (request.body.type === "event_callback") {
      const slackEvent: Event = Object.assign(new Event(), request.body);
      if (await slackEvent.findTeam()) {
        response.sendStatus(200);
        if (slackEvent.event.user !== slackEvent.team.botSlackId) {
          if (slackEvent.isMessageType()) { slackEvent.processMessageEvent(); }
        }
      } else {
        response.sendStatus(500);
      }
    }
  }
}
