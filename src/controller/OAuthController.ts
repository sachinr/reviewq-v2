import { WebAPICallResult, WebClient } from "@slack/web-api";
import { NextFunction, Request, Response } from "express";
import { Team } from "../entity/Team";
import { User } from "../entity/User";

interface IOAuthV2AccessResult extends WebAPICallResult {
  app_id: string;
  authed_user: { id: string; };
  scope: string;
  token_type: string;
  access_token: string;
  bot_user_id: string;
  team: {
    id: string;
    name: string;
  };
  enterprise: null;
}

export class OAuthController {

  public async oauth(request: Request, response: Response, next: NextFunction) {
    const code = request.query.code;
    if  (code) {
      const result = await (new WebClient()).oauth.v2.access({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
      }) as IOAuthV2AccessResult;

      if (result.ok) {
        let team = await Team.findOne({slackId: result.team.id});
        if (!team) {
          team = new Team();
          team.scope = result.scope;
          team.slackId = result.team.id;
          team.name = result.team.name;
          team.slackEnterpriseId = result.enterprise;
          team.botSlackId = result.bot_user_id;
          team.botToken = result.access_token;
          await team.save();
        }

        let user = await User.findOne({slackId: result.authed_user.id}, {relations: ["team"]});
        if (!user) {
          user = new User();
          user.slackId = result.authed_user.id;
          user.team = team;
        }
        user.installer = true;
        await user.fetchProfile();
        await user.save();

        response.redirect(`https://slack.com/app_redirect?app=${result.app_id}&team=${result.team.id}`);
      } else {
        return result.response_metadata;
      }
    }
  }
}
