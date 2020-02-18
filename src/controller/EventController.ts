import { NextFunction, Request, Response } from "express";
import { Event } from "../entity/Event";
import { verifySignature } from "../helpers/slackVerificationHelper";

export class EventController {
  public async event(request: Request, response: Response, next: NextFunction) {
    try {
      if (verifySignature(request)) {
        // tslint:disable-next-line: no-console
        console.log(request.body);
        switch (request.body.type) {
          case "url_verification":
            response.send({ challenge: request.body.challenge });
            break;

          case "event_callback":
            response.sendStatus(200);
            const slackEvent: Event = Object.assign(new Event(), request.body);
            if (await slackEvent.findTeams()) {
              switch (true) {
                case slackEvent.isMessageType():
                  slackEvent.processMessageEvent();
                  break;

                case slackEvent.isMemberJoined():
                  await slackEvent.findOrCreateSlackObjects();
                  await slackEvent.channel.postWelcomeMessage();
                  break;

                case slackEvent.appHomeOpened():
                  await slackEvent.findOrCreateSlackObjects();
                  await slackEvent.user.publishAppHome();
                  break;
              }
            }
            break;
          default:
            throw new Error(JSON.stringify(request.body));
        }
      }
    } catch (error) {
      next(error);
    }
  }
}
