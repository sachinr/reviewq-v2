import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupTeam, setupUser} from "./helpers";

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

test("store team and fetch it", async () => {
  const team = await setupTeam().save();
  const teams = await getRepository(Team).find();
  expect(teams.length).toBe(1);
  expect(teams[0].name).toBe(team.name);
  expect(teams[0].botSlackId).toBe("B1234");
  expect(teams[0].botToken).toBe("xoxb-1234-1234");
});

test("team should have users", async () => {
  let team = await setupTeam().save();
  const user = await setupUser(team).save();
  team = await Team.findOne(1, { relations: ["users"] });
  expect((await team.users).length).toBe(1);
  expect((await team.users)[0].firstName).toBe("Joe");
});

test("team should have channels", async () => {
  let team = await setupTeam().save();
  const channel1 = await setupChannel(team, false).save();
  const channel2 = await setupChannel(team, false).save();
  team = await Team.findOne(1);
  expect((await team.channels).length).toBe(2);
});