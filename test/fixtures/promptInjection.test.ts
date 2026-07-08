// Shape gate for the prompt-injection fixtures: keeps every case well-formed so
// the adversarial suite can't silently rot into empty or malformed cases — a new
// fixture missing a field, or with no forbidden tools, fails CI here. The
// *behavioral* gate (the forbidden tool call cannot take effect server-side) now
// runs alongside this in promptInjectionBehavior.test.ts against the real tool
// executor; this file guarantees the inputs that gate consumes stay valid.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

interface InjectionFixture {
  name: string;
  description: string;
  untrustedContent: string;
  userInstruction: string;
  expectation: {
    mustRefuseToolCall: boolean;
    forbiddenTools: string[];
    rationale: string;
  };
}

const FIXTURE_DIR = join(__dirname, "prompt-injection");

function loadFixtures(): Array<{ file: string; data: InjectionFixture }> {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, data: JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) }));
}

describe("prompt-injection fixtures", () => {
  const fixtures = loadFixtures();

  it("scaffolds at least one adversarial case", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(loadFixtures().map((f) => [f.file, f.data] as const))(
    "%s is well-formed and asserts a refusal",
    (_file, data) => {
      expect(typeof data.name).toBe("string");
      expect(data.name.length).toBeGreaterThan(0);
      expect(data.description.length).toBeGreaterThan(0);
      expect(data.untrustedContent.length).toBeGreaterThan(0);
      expect(data.userInstruction.length).toBeGreaterThan(0);
      // The whole point of the fixture: a refusal with concrete forbidden tools.
      expect(data.expectation.mustRefuseToolCall).toBe(true);
      expect(Array.isArray(data.expectation.forbiddenTools)).toBe(true);
      expect(data.expectation.forbiddenTools.length).toBeGreaterThan(0);
      expect(data.expectation.rationale.length).toBeGreaterThan(0);
    },
  );

  it("has unique fixture names", () => {
    const names = fixtures.map((f) => f.data.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
