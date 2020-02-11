import "reflect-metadata";

import * as bodyParser from "body-parser";
import dotenv from "dotenv";
import express from "express";
import { ConnectionOptions, createConnection } from "typeorm";

import { Routes } from "./routes";

import * as PostgressConnectionStringParser from "pg-connection-string";
import sourcemap from "source-map-support";

// initialize configuration
dotenv.config();
sourcemap.install();

let connectionOptions;
if (process.env.DATABASE_URL) {
  connectionOptions = PostgressConnectionStringParser.parse(process.env.DATABASE_URL);
}

createConnection({
  database: connectionOptions?.database || process.env.TYPEORM_DATABASE,
  entities: ["./dist/entity/**/*.js"],
  host: connectionOptions?.host || process.env.TYPEORM_HOST,
  logging: process.env.TYPEORM_LOGGING,
  migrations: ["./dist/migrations/**/*.js"],
  password: connectionOptions?.password || process.env.TYPEORM_PASSWORD,
  port: connectionOptions?.port || 5432,
  subscribers: ["./dist/subscribers/**/*.js"],
  synchronize: process.env.TYPEORM_SYNCHRONIZE === "true",
  type: "postgres",
  username: connectionOptions?.user || process.env.TYPEORM_USERNAME,
} as ConnectionOptions).then(async (connection) => {
  const app = express();

  const rawBodySaver = (req: express.Request, res: express.Response, buf: Buffer, encoding: string) => {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || "utf8");
    }
  };

  // setup express app here
  app.use(bodyParser.urlencoded({ verify: rawBodySaver, extended: true }));
  app.use(bodyParser.json({ verify: rawBodySaver }));
  app.use(express.static("public"));

  // register express routes from defined application routes
  Routes.forEach((route) => {
    // tslint:disable-next-line: ban-types
    (app as any)[route.method](route.route, (req: express.Request, res: express.Response, next: Function) => {
      const result = (new (route.controller as any)())[route.action](req, res, next);
      if (result instanceof Promise) {
        // tslint:disable-next-line: no-shadowed-variable
        result.then((result) => result !== null && result !== undefined ? res.send(result) : undefined);
      } else if (result !== null && result !== undefined) {
        res.json(result);
      }
    });
  });

  // start express server
  app.listen(process.env.PORT);

  // tslint:disable-next-line: no-console
  console.log(`${process.env.NODE_ENV} // Express server has started on port ${process.env.PORT}`);

  // tslint:disable-next-line: no-console
}).catch((error) => console.log(error));
