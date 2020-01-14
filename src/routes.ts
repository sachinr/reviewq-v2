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
  action: "all",
  controller: UserController,
  method: "get",
  route: "/users",
}, {
  action: "one",
  controller: UserController,
  method: "get",
  route: "/users/:id",
}, {
  action: "save",
  controller: UserController,
  method: "post",
  route: "/users",
}, {
  action: "remove",
  controller: UserController,
  method: "delete",
  route: "/users/:id",
}];
