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

test("store team and fetch it", async () => {
  const team = await setupTeam();
  const teams = await getRepository(Team).find();
  expect(teams.length).toBe(1);
  expect(teams[0].name).toBe("LLL");
  expect(teams[0].botSlackId).toBe("B1234");
  expect(teams[0].botToken).toBe("xoxb-1234-1234");
});

test("team should have users", async () => {
  let team = await setupTeam();
  const user = await setupUser(team);
  team = await getRepository(Team).findOne(1, { relations: ["users"] });
  expect(team.users.length).toBe(1);
  expect(team.users[0].firstName).toBe("Joe");
});
