import { EventController } from "./controller/EventController";
import { IndexController } from "./controller/IndexController";
import { OAuthController } from "./controller/OAuthController";
import { UserController } from "./controller/UserController";

export const Routes = [{
  action: "index",
  controller: IndexController,
  method: "get",
  route: "/",
}, {
  action: "oauth",
  controller: OAuthController,
  method: "get",
  route: "/oauth",
}, {
  action: "event",
  controller: EventController,
  method: "post",
  route: "/events",
}];
