import {createConnection, getConnection } from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Item} from "../entity/Item";
import {Message} from "../entity/Message";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

import { Button, PlainTextElement } from "@slack/types";
import { ActionsBlock, ContextBlock } from "@slack/web-api";

jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn(() => {
    return {
      chat: {
        getPermalink: jest.fn(() => {
          return { ok: true };
        }),
        postMessage: jest.fn(),
      },
      conversations: {
        info: jest.fn(() => {
          return { ok: true, channel: { is_channel: true } };
        }),
      },
      team: {
        info: jest.fn(() => {
          return { ok: true, team: { domain: "testsuite.com" } };
        }),
      },
    };
  }),
}));

User.prototype.fetchProfile = jest.fn();

beforeEach(() => {
  return createConnection({
    database: ":memory:",
    dropSchema: true,
    entities: [User, Team, Item, Channel],
    logging: false,
    synchronize: true,
    type: "sqlite",
  });
});

afterEach(() => {
  jest.clearAllMocks();
  const conn = getConnection();
  return conn.close();
});

test("paginates through open items", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const items: Item[] = [];
  for (const i of [1, 2, 3, 4, 5, 6, 7]) {
    items.push(await setupItem(channel, user).save());
  }
  const message = new Message(channel);
  await message.addItems(items, 1, false);
  let actions = message.blocks[message.blocks.length - 1] as ActionsBlock;
  expect(actions.elements.length).toBe(2);
  expect((actions.elements[0] as Button).text.text).toBe("Next");
  expect((actions.elements[1] as Button).text.text).toBe("Minimize");
  let paginationContext = message.blocks[message.blocks.length - 2] as ContextBlock;
  expect((paginationContext.elements[0] as PlainTextElement).text).toBe("Page 1 of 3");

  const message2 = new Message(channel);
  await message2.addItems(items, JSON.parse((actions.elements[0] as Button).action_id).start, false);
  actions = message2.blocks[message2.blocks.length - 1] as ActionsBlock;
  expect(actions.elements.length).toBe(3);
  expect((actions.elements[0] as Button).text.text).toBe("Next");
  expect((actions.elements[1] as Button).text.text).toBe("Previous");
  expect((actions.elements[2] as Button).text.text).toBe("Minimize");
  paginationContext = message2.blocks[message2.blocks.length - 2] as ContextBlock;
  expect((paginationContext.elements[0] as PlainTextElement).text).toBe("Page 2 of 3");

  const message3 = new Message(channel);
  await message3.addItems(items, JSON.parse((actions.elements[0] as Button).action_id).start, false);
  actions = message3.blocks[message3.blocks.length - 1] as ActionsBlock;
  expect(actions.elements.length).toBe(2);
  expect((actions.elements[0] as Button).text.text).toBe("Previous");
  expect((actions.elements[1] as Button).text.text).toBe("Minimize");
  paginationContext = message3.blocks[message3.blocks.length - 2] as ContextBlock;
  expect((paginationContext.elements[0] as PlainTextElement).text).toBe("Page 3 of 3");
});
