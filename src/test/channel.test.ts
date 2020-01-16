import {createConnection, getConnection, getRepository} from "typeorm";

import {setupTeam, setupChannel, setupItem, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

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