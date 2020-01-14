import {getRepository} from "typeorm";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

export const setupTeam = async () => {
  const team = new Team();
  team.name = "LLL";
  team.slackId = "T1234";
  team.botSlackId = "B1234";
  team.botToken = "xoxb-1234-1234";
  team.scope = "app_mention,users:read";
  await getRepository(Team).save(team);

  return team;
};

export const setupUser = async (team: Team) => {
  const user = new User();
  user.firstName = "Joe";
  user.lastName = "Shmoe";
  user.team = team;
  user.slackId = "U1234";
  user.slackUserName = "joeshmoe";

  await getRepository(User).save(user);

  return user;
};
