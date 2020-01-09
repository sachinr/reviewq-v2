import {createConnection, getConnection, getRepository} from "typeorm";
import {User} from "../entity/User";

beforeEach(() => {
  return createConnection({
    database: ":memory:",
    dropSchema: true,
    entities: [User],
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
  const user = new User();
  user.firstName = "Joe";
  user.lastName = "Shmoe";
  user.age = 33;

  await getRepository(User).save(user);
  const users = await getRepository(User).find();
  expect(users.length).toBe(1);
  expect(users[0].firstName).toBe("Joe");
  expect(users[0].lastName).toBe("Shmoe");
  expect(users[0].age).toBe(33);
});
