import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFollower, followTarget } from "./followScroll";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

describe("followScroll", () => {
  it("places_the_sentence_one_line_into_the_upper_third", () => {
    assert.equal(followTarget({ markTop: 0, lineHeight: 24 }), 0);
    assert.equal(followTarget({ markTop: 10, lineHeight: 24 }), 0);
    assert.equal(followTarget({ markTop: 200, lineHeight: 24 }), 176);
    assert.equal(followTarget({ markTop: 1000, lineHeight: 20 }), 980);
  });

  it("user_scroll_away_stops_following", () => {
    const follower = createFollower();
    assert.equal(follower.shouldFollow(), true);
    follower.userScrolled(false);
    assert.equal(follower.shouldFollow(), false);
  });

  it("user_scroll_that_keeps_the_mark_in_view_keeps_following", () => {
    const follower = createFollower();
    follower.userScrolled(true);
    assert.equal(follower.shouldFollow(), true);
  });

  it("back_in_view_resumes", () => {
    const follower = createFollower();
    follower.userScrolled(false);
    follower.userScrolled(true);
    assert.equal(follower.shouldFollow(), true);
  });

  it("own_scroll_never_stops_following", () => {
    const follower = createFollower();
    follower.programmatic();
    follower.userScrolled(false);
    assert.equal(follower.shouldFollow(), true);
    follower.userScrolled(false);
    assert.equal(follower.shouldFollow(), false);
  });

  it("a_fresh_reading_view_resumes_following", () => {
    const follower = createFollower();
    follower.userScrolled(false);
    follower.programmatic();
    follower.reset();
    assert.equal(follower.shouldFollow(), true);
    follower.userScrolled(false);
    assert.equal(follower.shouldFollow(), false);
  });

  it("the_next_sentence_keeps_a_suspension", () => {
    const follower = createFollower();
    follower.sentenceStarted(0);
    follower.sentenceStarted(12);
    follower.userScrolled(false);
    follower.sentenceStarted(12);
    follower.sentenceStarted(30);
    assert.equal(follower.shouldFollow(), false);
  });

  it("a_new_read_from_the_start_resumes_following", () => {
    const follower = createFollower();
    follower.sentenceStarted(40);
    follower.userScrolled(false);
    follower.sentenceStarted(0);
    assert.equal(follower.shouldFollow(), true);
  });
});
