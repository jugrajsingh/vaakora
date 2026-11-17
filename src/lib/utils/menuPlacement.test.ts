import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { menuPlacement } from "./menuPlacement";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const menuHeight = 240;

describe("menuPlacement", () => {
  it("room_below_opens_below", () => {
    assert.equal(
      menuPlacement({
        triggerTop: 100,
        triggerBottom: 130,
        limitTop: 0,
        limitBottom: 560,
        menuHeight,
      }),
      "below",
    );
  });

  it("room_below_is_measured_with_the_gap", () => {
    const box = {
      triggerTop: 300,
      triggerBottom: 330,
      limitTop: 0,
      menuHeight,
    };
    assert.equal(menuPlacement({ ...box, limitBottom: 330 + 244 }), "below");
    assert.equal(menuPlacement({ ...box, limitBottom: 330 + 243 }), "above");
  });

  it("bottom_row_opens_above", () => {
    assert.equal(
      menuPlacement({
        triggerTop: 520,
        triggerBottom: 550,
        limitTop: 0,
        limitBottom: 560,
        menuHeight,
      }),
      "above",
    );
  });

  it("no_room_either_side_prefers_the_larger", () => {
    assert.equal(
      menuPlacement({
        triggerTop: 50,
        triggerBottom: 80,
        limitTop: 0,
        limitBottom: 300,
        menuHeight,
      }),
      "below",
    );
    assert.equal(
      menuPlacement({
        triggerTop: 200,
        triggerBottom: 230,
        limitTop: 0,
        limitBottom: 300,
        menuHeight,
      }),
      "above",
    );
  });

  it("equal_room_stays_below", () => {
    assert.equal(
      menuPlacement({
        triggerTop: 100,
        triggerBottom: 130,
        limitTop: 0,
        limitBottom: 230,
        menuHeight,
      }),
      "below",
    );
  });
});
