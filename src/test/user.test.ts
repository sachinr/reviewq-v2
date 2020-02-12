import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

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

test("store user and fetch it", async () => {
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const users = await getRepository(User).find();
  expect(users.length).toBe(1);
  expect(users[0].firstName).toBe(user.firstName);
  expect(users[0].lastName).toBe(user.lastName);
});

test("user belongs to a team", async () => {
  const team = await setupTeam().save();
  await setupUser(team).save();
  const user = await getRepository(User).findOne(1, { relations: ["team"] });
  expect((await user.team).name).toBe(team.name);
});

test("user has many items", async () => {
  const team = await setupTeam().save();
  let user = await setupUser(team).save();
  const channel = await setupChannel(team, false).save();
  await setupItem(channel, user).save();
  user = await getRepository(User).findOne(1, { relations: ["team", "items"] });
  expect(user.items.length).toBe(1);
});
