import { expect, test } from "bun:test";
import { describeActivity } from "./sync";

test("a cycle's activity counts files per skill and direction, never listing paths", () => {
  expect(describeActivity({
    pulled: ["senior-swe/SKILL.md", "agentic-collaboration/SKILL.md", "agentic-collaboration/examples/a.md"],
    pushed: ["jive/SKILL.md"],
    deletedLocally: [],
    rejected: ["bad/../x"],
  })).toBe("pulled 3 files: agentic-collaboration 2, senior-swe 1; pushed 1 file: jive 1");
  expect(describeActivity({ pulled: [], pushed: [], deletedLocally: [], rejected: [] })).toBe("");
});
