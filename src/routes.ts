import { IndexController } from "./controller/IndexController";
import { UserController } from "./controller/UserController";

export const Routes = [{
  action: "index",
  controller: IndexController,
  method: "get",
  route: "/",
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
