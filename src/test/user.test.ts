import {createConnection, getConnection, getRepository} from "typeorm";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

beforeEach(() => {
  return createConnection({
    database: ":memory:",
    dropSchema: true,
    entities: [User, Team, Item],
    logging: false,
    synchronize: true,
    type: "sqlite",
  });
});

afterEach(() => {
  const conn = getConnection();
  return conn.close();
});

const setupTeam = async () => {
  const team = new Team();
  team.name = "LLL";
  team.botSlackId = "B1234";
  team.botToken = "xoxb-1234-1234";
  await getRepository(Team).save(team);

  return team;
};

const setupUser = async (team: Team) => {
  const user = new User();
  user.firstName = "Joe";
  user.lastName = "Shmoe";
  user.team = team;
  user.slackId = "U1234";
  user.slackUserName = "joeshmoe";

  await getRepository(User).save(user);

  return user;
};

test("store user and fetch it", async () => {
  const team = await setupTeam();
  await setupUser(team);
  const users = await getRepository(User).find();
  expect(users.length).toBe(1);
  expect(users[0].firstName).toBe("Joe");
  expect(users[0].lastName).toBe("Shmoe");
});

test("user belongs to a team", async () => {
  const team = await setupTeam();
  await setupUser(team);
  const user = await getRepository(User).findOne(1, { relations: ["team"] });
  expect(user.team.name).toBe("LLL");
});

test("user has many items", async () => {
  const team = await setupTeam();
  await setupUser(team);
  let user = await getRepository(User).findOne(1, { relations: ["team", "items"] });
  const item = new Item();
  item.user = user;
  item.ts = "123";
  await getRepository(Item).save(item);

  user = await getRepository(User).findOne(1, { relations: ["team", "items"] });
  expect(user.items.length).toBe(1);
});
