import { NextFunction, Request, Response } from "express";
import { Event } from "../entity/Event";
import { verifySignature } from "../helpers/slackVerificationHelper";

export class EventController {
  public async event(request: Request, response: Response, next: NextFunction) {
    if (verifySignature(request)) {
      switch (request.body.type) {
        case "url_verification":
          response.send({ challenge: request.body.challenge });
          break;

        case "event_callback":
          response.sendStatus(200);
          // tslint:disable-next-line: no-console
          console.log(request.body.event.attachments);
          const slackEvent: Event = Object.assign(new Event(), request.body);
          if (await slackEvent.findTeam()) {
            if (slackEvent.event.user !== slackEvent.team.botSlackId) {
              if (slackEvent.isMessageType()) { slackEvent.processMessageEvent(); }
            }
          }
          break;

        default:
          response.sendStatus(500);
      }
    } else {
      response.sendStatus(500);
    }
  }
}
