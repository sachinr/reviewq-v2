import { NextFunction, Request, Response } from "express";
import { Command } from "../entity/Command";
import { verifySignature } from "../helpers/slackVerificationHelper";

export class CommandController {

  public async commands(request: Request, response: Response, next: NextFunction) {
    try {
      if (verifySignature(request)) {
        response.send("");
        const command: Command = Object.assign(new Command(), request.body);
        if (await command.findTeam()) {
          await command.findOrCreateSlackObjects();
          if (command.text === "private") {
            command.channel.postInfoEphemeral(command.user_id, "");
          } else {
            command.channel.postInfo("", command.response_url);
          }
        }
      }
    } catch (error) {
      next(error);
    }
  }
}
