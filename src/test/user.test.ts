import {createConnection, getConnection, getRepository} from "typeorm";

import {setupTeam, setupUser} from "./helpers";

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

test("store user and fetch it", async () => {
  const team = setupTeam();
  await team.save();
  await setupUser(team).save();
  const users = await getRepository(User).find();
  expect(users.length).toBe(1);
  expect(users[0].firstName).toBe("Joe");
  expect(users[0].lastName).toBe("Shmoe");
});

test("user belongs to a team", async () => {
  const team = await setupTeam();
  await team.save();
  await setupUser(team).save();
  const user = await getRepository(User).findOne(1, { relations: ["team"] });
  expect(user.team.name).toBe("LLL");
});

test("user has many items", async () => {
  const team = setupTeam();
  team.save()
  await setupUser(team).save();
  let user = await getRepository(User).findOne(1, { relations: ["team", "items"] });
  const item = new Item();
  item.user = user;
  item.ts = "123";
  await getRepository(Item).save(item);

  user = await getRepository(User).findOne(1, { relations: ["team", "items"] });
  expect(user.items.length).toBe(1);
});
