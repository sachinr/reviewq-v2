import Item from "../item";

test("basic", () => {
  const item: Item = new Item(1234, 1234, "1234.1234", "this is a test message");
  expect(item.archiveLink).toBe("https://peeeps.slack.com/archives/general/p12341234");
});
