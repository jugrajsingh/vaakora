import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createLimitField, parseLimit } from "./limitField";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

describe("parseLimit", () => {
  it("accepts whole numbers from 0 to 1000", () => {
    assert.equal(parseLimit("0"), 0);
    assert.equal(parseLimit(" 25 "), 25);
    assert.equal(parseLimit("1000"), 1000);
  });
  it("refuses anything else", () => {
    for (const text of ["", "1001", "-1", "2.5", "ten", "1e3"]) {
      assert.equal(parseLimit(text), null, text);
    }
  });
});

describe("createLimitField", () => {
  function field(current = 5) {
    const calls: string[] = [];
    const limit = createLimitField({
      current: () => current,
      update: (value) => calls.push(`update ${value}`),
      show: (draft) => calls.push(`show ${draft}`),
    });
    return { calls, limit };
  }
  it("limit_draft_commits_only_on_blur_or_enter", () => {
    const { calls, limit } = field();
    limit.type("2");
    limit.type("20");
    assert.deepEqual(calls, ["show 2", "show 20"]);
    limit.commit();
    assert.deepEqual(calls.slice(2), ["update 20", "show null"]);
  });
  it("Enter commits and other keys do not", () => {
    const { calls, limit } = field();
    limit.type("7");
    limit.key("a");
    assert.ok(!calls.some((call) => call.startsWith("update")));
    limit.key("Enter");
    assert.ok(calls.includes("update 7"), calls.join());
  });
  it("drops an invalid or unchanged draft without updating", () => {
    for (const text of ["", "5", "1001", "x"]) {
      const { calls, limit } = field(5);
      limit.type(text);
      limit.commit();
      assert.ok(!calls.some((call) => call.startsWith("update")), text);
      assert.equal(calls[calls.length - 1], "show null");
    }
  });
  it("commit with nothing typed does nothing", () => {
    const { calls, limit } = field();
    limit.commit();
    assert.ok(!calls.some((call) => call.startsWith("update")));
  });
});
