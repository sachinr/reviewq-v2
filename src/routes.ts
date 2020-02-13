import { CommandController } from "./controller/CommandController";
import { EventController } from "./controller/EventController";
import { IndexController } from "./controller/IndexController";
import { InteractiveMessageController } from "./controller/InteractiveMessageController";
import { OAuthController } from "./controller/OAuthController";

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
  action: "install",
  controller: OAuthController,
  method: "get",
  route: "/install",
}, {
  action: "event",
  controller: EventController,
  method: "post",
  route: "/events",
}, {
  action: "interactiveMessage",
  controller: InteractiveMessageController,
  method: "post",
  route: "/interactive-message",
}, {
  action: "commands",
  controller: CommandController,
  method: "post",
  route: "/commands",
},
];
