import { NextFunction, Request, Response } from "express";

export class IndexController {

  public async index(request: Request, response: Response, next: NextFunction) {
    const scopes = ["app_mentions:read", "channels:join", "channels:read", "chat:write", "commands",
      "groups:read", "im:history", "im:read", "mpim:read", "reactions:read", "reactions:write",
      "team:read", "users:read"];
    // tslint:disable-next-line: max-line-length
    response.send(`https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=${scopes.join()}`);
  }
}
