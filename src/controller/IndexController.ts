import {NextFunction, Request, Response} from "express";

export class IndexController {

    public async index(request: Request, response: Response, next: NextFunction) {
      return "Hello World!";
    }
}
