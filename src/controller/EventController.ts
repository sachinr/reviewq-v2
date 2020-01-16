import { NextFunction, Request, Response } from "express";
import { Event } from "../entity/Event";
import { Item } from "../entity/Item";

export class EventController {
  public async event(request: Request, response: Response, next: NextFunction) {
    if (request.body.type === "url_verification") {
      response.send({ challenge: request.body.challenge });
    } else if (request.body.type === "event_callback") {
      const slackEvent: Event = Object.assign(new Event(), request.body);
      switch (slackEvent.event.type) {
        case "app_mention":
        case "message":
          const str: string = slackEvent.event.text.toLowerCase();
          switch (str) {
            case String(str.match(/^<@#{@team.bot_slack_id}> add/)):
              // add_item(event, event.text)
              break;
            case String(str.match(/^add/)):
              if (slackEvent.event.channel[0] === "D") {
                response.sendStatus(200);
                await slackEvent.findOrCreateSlackObjects();
              }
              break;
            case String(str.match(/<@#{@team.bot_slack_id}>/)):
              break;
              // add_item(event, event.text,  vague: true)
            case String(str.match(/^<@#{@team.bot_slack_id}> list/)):
              // list_items(event)
              break;
            case String(str.match(/^list/)):
              // if event.channel[0] == 'D'
              //   list_items(event)
              // end
              break;
            case String(str.match(/^<@#{@team.bot_slack_id}> help/)):
              // Bot.send_help_message(@team.bot_token, event.channel)
              break;
            case "help":
            case "hi":
            case "hello":
              response.sendStatus(200);
              // if event.channel[0] == 'D'
              //   Bot.send_help_message(@team.bot_token, event.channel)
              // end
              break;
          default:
            break;
          }
        default:
          break;
      }
    }
  }
}
