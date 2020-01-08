import "reflect-metadata";

import * as bodyParser from "body-parser";
import dotenv from "dotenv";
import {createConnection} from "typeorm";

import express from "express";
import {Routes} from "./routes";

// initialize configuration
dotenv.config();

createConnection().then(async (connection) => {

  // create express app
  const app = express();
  app.use(bodyParser.json());

  // register express routes from defined application routes
  Routes.forEach((route) => {
      // tslint:disable-next-line: ban-types
      (app as any)[route.method](route.route, (req: express.Request, res: express.Response, next: Function) => {
          const result = (new (route.controller as any)())[route.action](req, res, next);
          if (result instanceof Promise) {
              result.then((r) => result !== null && result !== undefined ? res.send(result) : undefined);

          } else if (result !== null && result !== undefined) {
              res.json(result);
          }
      });
  });

  // setup express app here
  // ...

  // start express server
  app.listen(process.env.SERVER_PORT);

  // tslint:disable-next-line: no-console
  console.log(`Express server has started on port ${process.env.SERVER_PORT}. Open http://localhost:${process.env.SERVER_PORT}/users to see results`);

// tslint:disable-next-line: no-console
}).catch((error) => console.log(error));
