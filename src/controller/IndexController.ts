import { NextFunction, Request, Response } from "express";

export class IndexController {

  public async index(request: Request, response: Response, next: NextFunction) {
    return "https://slack.com/oauth/v2/authorize?client_id=22349320545.905600286708&scope=app_mentions:read,channels:join,channels:read,chat:write,groups:read,im:read,mpim:read,reactions:write,users:read,im:history,team:read";
  }
}
