// for Sentry
declare global {
  namespace NodeJS {
    // tslint:disable-next-line: interface-name
    interface Global {
      __rootdir__: string;
    }
  }
}

global.__rootdir__ = __dirname || process.cwd();

import "reflect-metadata";

import { RewriteFrames } from "@sentry/integrations";
import * as Sentry from "@sentry/node";
import * as bodyParser from "body-parser";
import dotenv from "dotenv";
import express from "express";
import * as PostgressConnectionStringParser from "pg-connection-string";
import sourcemap from "source-map-support";
import { ConnectionOptions, createConnection } from "typeorm";

import { CommandController } from "./controller/CommandController";
import { EventController } from "./controller/EventController";
import { IndexController } from "./controller/IndexController";
import { InteractiveMessageController } from "./controller/InteractiveMessageController";
import { OAuthController } from "./controller/OAuthController";

// initialize configuration
dotenv.config();
sourcemap.install();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  integrations: [new RewriteFrames({
    root: global.__rootdir__,
  })],
});

let connectionOptions;
// Heroku sets DATABASE_URL env var
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
  // use ejs for views
  app.set("view engine", "ejs");

  // add rawBody to request object so that Slack signatures can be verified. See custom.d.ts
  const rawBodySaver = (req: express.Request, res: express.Response, buf: Buffer, encoding: string) => {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || "utf8");
    }
  };

  // Sentry must be first middleware
  app.use(Sentry.Handlers.requestHandler() as express.RequestHandler);
  // add rawBody to request for signature verification
  app.use(bodyParser.urlencoded({ verify: rawBodySaver, extended: true }));
  app.use(bodyParser.json({ verify: rawBodySaver }));

  // serve any static assets in public folder
  app.use(express.static("public"));
  app.use(express.static("views"));

  app.get("/", (req, res, next) =>  {
    if (process.env.NODE_ENV === "development") {
      new IndexController().index(req, res, next);
    } else {
      res.send(404);
    }
  });

  app.get("/oauth", (req, res, next) =>  {
    new OAuthController().oauth(req, res, next);
  });

  app.get("/install", (req, res, next) =>  {
    new OAuthController().install(req, res, next);
  });

  app.post("/events", (req, res, next) =>  {
    new EventController().event(req, res, next);
  });

  app.post("/interactive-message", (req, res, next) =>  {
    new InteractiveMessageController().interactiveMessage(req, res, next);
  });

  app.post("/commands", (req, res, next) =>  {
    new CommandController().commands(req, res, next);
  });

  // must be after routes to catch errors passed to next()
  app.use(Sentry.Handlers.errorHandler() as express.ErrorRequestHandler);

  // start express server
  app.listen(process.env.PORT);

  // tslint:disable-next-line: no-console
  console.log(`${process.env.NODE_ENV} // ${global.__rootdir__} // Express server has started on port ${process.env.PORT}`);
});
