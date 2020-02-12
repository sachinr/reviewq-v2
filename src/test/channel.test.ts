import {createConnection, getConnection} from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

const getPermalink = jest.fn(() => {
  return { ok: true };
});

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
  const conn = getConnection();
  return conn.close();
});

test("fetch open items", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  await setupItem(channel, user).save();
  const item2 = setupItem(channel, user);
  item2.complete = true;
  await item2.save();

  expect((await channel.openItems()).length).toBe(1);
  expect((await channel.openItems())[0].id).toBe(1);
});

test("calls conversation.info after save", async () => {
  const team = await setupTeam().save();
  const channel = setupChannel(team, false)
  expect(channel.type).toBe(undefined);
  expect(channel.isExtShared).toBe(undefined);

  await channel.save();

  expect(channel.type).toBe("channel");
  expect(channel.isExtShared).toBe(false);
});

test("calls conversation.info after update", async () => {
  const team = await setupTeam().save();
  const channel = setupChannel(team, false);
  await channel.save();
  channel.type = "im";
  channel.isExtShared = true;
  await channel.save();

  expect(channel.type).toBe("channel");
  expect(channel.isExtShared).toBe(false);
});
