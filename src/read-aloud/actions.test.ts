import assert from "node:assert/strict";
import { controls, createPopupActions, type PopupSnapshot } from "./actions";

let snapshot: PopupSnapshot = {
  epoch: 3,
  state: "waiting",
  text: "",
  source_start: 0,
  source_end: 0,
};
const calls: string[] = [];
let release: () => void = () => {};
const pendingPlay = new Promise<void>((resolve) => {
  release = resolve;
});
const actions = createPopupActions(
  () => snapshot,
  (next) => {
    snapshot = next;
  },
  {
    play: async () => {
      calls.push("play");
      await pendingPlay;
    },
    pause: async () => {
      calls.push("pause");
    },
    stop: async () => {
      calls.push("stop");
    },
    replaceText: async (text) => {
      calls.push(`replace:${text}`);
    },
    close: async () => {
      calls.push("close");
    },
    readClipboard: async () => {
      calls.push("readClipboard");
    },
    error: (key) => {
      calls.push(key);
    },
  },
);
assert.equal(controls(snapshot).canPlay, false);
await actions.toggle();
assert.equal(calls.length, 0);
snapshot = { ...snapshot, text: "read this" };
const first = actions.toggle();
await actions.toggle();
assert.deepEqual(calls, ["play"]);
release();
await first;
snapshot = { ...snapshot, state: "playing" };
await actions.toggle();
assert.equal(calls[calls.length - 1], "pause");
await Promise.all([actions.edit("older"), actions.edit("newer")]);
assert.equal(calls.includes("replace:older"), false);
assert.equal(calls[calls.length - 1], "replace:newer");
actions.event({ ...snapshot, epoch: 2, text: "stale" });
assert.equal(snapshot.text, "read this");
const beforeClipboard = calls.length;
await actions.readClipboard();
assert.deepEqual(
  calls.slice(beforeClipboard),
  ["readClipboard"],
  "Read clipboard calls its command once, in any state",
);
await actions.close();
await actions.readClipboard();
assert.equal(
  calls[calls.length - 1],
  "close",
  "a closed popup never reads the clipboard",
);
actions.event({ ...snapshot, epoch: 99, text: "late" });
assert.equal(snapshot.text, "read this");
console.log(
  "read-aloud actions: empty/busy/edit/epoch/close assertions passed",
);

for (const [state, playCount] of [
  ["starting", 0],
  ["paused", 1],
  ["error", 1],
  ["playing", 1],
  ["waiting", 1],
] as const) {
  let plays = 0;
  let stops = 0;
  const view: PopupSnapshot = { ...snapshot, text: "read this", state };
  const guarded = createPopupActions(
    () => view,
    () => {},
    {
      play: async () => {
        plays++;
      },
      pause: async () => {},
      stop: async () => {
        stops++;
      },
      replaceText: async () => {},
      close: async () => {},
      readClipboard: async () => {},
      error: () => {},
    },
  );
  await guarded.play();
  await guarded.edit("typed");
  assert.equal(plays, playCount, `${state} play dependency count`);
  assert.equal(stops, 1, `${state}: the editor stops the read once per edit`);
  assert.equal("stop" in guarded, false, `${state}: no popup stop action`);
}
let emptyPlays = 0;
const empty = createPopupActions(
  () => ({ ...snapshot, text: "", state: "waiting" }),
  () => {},
  {
    play: async () => {
      emptyPlays++;
    },
    pause: async () => {},
    stop: async () => {},
    replaceText: async () => {},
    close: async () => {},
    readClipboard: async () => {},
    error: () => {},
  },
);
await empty.play();
assert.equal(emptyPlays, 0, "empty play dependency count");
console.log("popup per-state play/stop dependency counts passed");

const { routePopupKey } = await import("./actions");
const keys: string[] = [];
const keyActions = {
  close: () => {
    keys.push("close");
  },
  toggle: () => {
    keys.push("toggle");
  },
};
for (const [key, ctrlKey] of [
  [" ", false],
  ["Enter", false],
  ["Enter", true],
  ["Escape", false],
] as const) {
  routePopupKey(
    {
      key,
      ctrlKey,
      defaultPrevented: false,
      preventDefault: () => {
        keys.push("prevent");
      },
    },
    keyActions,
  );
}
assert.deepEqual(
  keys,
  ["prevent", "toggle", "prevent", "close"],
  "Textarea Space and Enter stay text; Ctrl+Enter and Escape route",
);

{
  const trace: string[] = [];
  let finishReplace: () => void = () => {};
  const view: PopupSnapshot = {
    ...snapshot,
    text: "typed",
    state: "finished",
  };
  const reader = createPopupActions(
    () => view,
    () => {},
    {
      play: async () => {},
      pause: async () => {},
      stop: async () => {
        trace.push("stop");
      },
      replaceText: async (text) => {
        await new Promise<void>((resolve) => {
          finishReplace = resolve;
        });
        trace.push(`replace:${text}`);
      },
      close: async () => {},
      readClipboard: async () => {
        trace.push("readClipboard");
      },
      error: (key) => {
        trace.push(key);
      },
    },
  );
  const editing = reader.edit("typed more");
  const reading = reader.readClipboard();
  await Promise.resolve();
  assert.equal(
    trace.includes("readClipboard"),
    false,
    "Read clipboard waits for the edit in flight",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishReplace();
  await Promise.all([editing, reading]);
  assert.deepEqual(trace, ["stop", "replace:typed more", "readClipboard"]);
  let reported = "";
  const failing = createPopupActions(
    () => view,
    () => {},
    {
      play: async () => {},
      pause: async () => {},
      stop: async () => {},
      replaceText: async () => {},
      close: async () => {},
      readClipboard: async () => {
        throw new Error("clipboard command failed");
      },
      error: (key) => {
        reported = key;
      },
    },
  );
  await failing.readClipboard();
  assert.equal(reported, "tts.errors.generic");
  console.log(
    "popup Read clipboard: command, ordering and error assertions passed",
  );
}

for (const interrupt of ["edit", "toggle", "close"] as const) {
  const trace: string[] = [];
  const settle: (() => void)[] = [];
  const view: PopupSnapshot = {
    ...snapshot,
    text: "typed",
    state: "playing",
  };
  const queued = createPopupActions(
    () => view,
    () => {},
    {
      play: async () => {},
      pause: async () => {},
      stop: async () => {
        trace.push("stop");
      },
      replaceText: async (text) => {
        await new Promise<void>((resolve) => settle.push(resolve));
        trace.push(`replace:${text}`);
      },
      close: async () => {
        trace.push("close");
      },
      readClipboard: async () => {
        trace.push("readClipboard");
      },
      error: (key) => {
        trace.push(key);
      },
    },
  );
  const first = queued.edit("A");
  const reading = queued.readClipboard();
  const second =
    interrupt === "edit"
      ? queued.edit("B")
      : interrupt === "toggle"
        ? queued.toggle()
        : queued.close();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    settle.splice(0).forEach((resolve) => resolve());
  }
  await Promise.all([first, reading, second]);
  assert.equal(
    trace.includes("readClipboard"),
    false,
    `a newer ${interrupt} cancels the queued Read clipboard: ${trace.join(",")}`,
  );
  if (interrupt === "edit")
    assert.equal(
      trace.includes("replace:B"),
      true,
      "the newer edit still lands",
    );
}
console.log(
  "popup Read clipboard: queued action cancelled by edit, Play or Pause and Close",
);

{
  const reported: string[] = [];
  const reasons = {
    play: new Error("tts.errors.busy") as unknown,
    replaceText: new Error("tts.errors.busy") as unknown,
  };
  const view: PopupSnapshot = {
    ...snapshot,
    text: "read this",
    state: "waiting",
  };
  const refusing = () =>
    createPopupActions(
      () => view,
      () => {},
      {
        play: async () => {
          throw reasons.play;
        },
        pause: async () => {},
        stop: async () => {},
        replaceText: async () => {
          throw reasons.replaceText;
        },
        close: async () => {},
        readClipboard: async () => {},
        error: (key) => {
          reported.push(key);
        },
      },
    );
  // named_refusal_keeps_its_key
  await refusing().play();
  await refusing().edit("typed");
  assert.deepEqual(
    reported,
    ["tts.errors.busy", "tts.errors.busy"],
    "named_refusal_keeps_its_key",
  );
  // unnamed_failure_is_generic
  reported.length = 0;
  reasons.play = new Error("worker crashed");
  reasons.replaceText = "tts.errors.busy";
  await refusing().play();
  await refusing().edit("typed");
  assert.deepEqual(
    reported,
    ["tts.errors.generic", "tts.errors.generic"],
    "unnamed_failure_is_generic",
  );
  console.log("popup errors: named refusal keys and generic fallback passed");
}

{
  // stop_failure_in_an_edit_keeps_its_reason
  const view: PopupSnapshot = {
    ...snapshot,
    text: "read this",
    state: "playing",
  };
  const trace: string[] = [];
  const stops: ((reason?: unknown) => void)[] = [];
  const editor = () =>
    createPopupActions(
      () => view,
      () => {},
      {
        play: async () => {},
        pause: async () => {},
        stop: () =>
          new Promise<void>((resolve, reject) => {
            stops.push((reason) =>
              reason === undefined ? resolve() : reject(reason),
            );
          }),
        replaceText: async (text) => {
          trace.push(`replace:${text}`);
        },
        close: async () => {},
        readClipboard: async () => {},
        error: (key) => {
          trace.push(`error:${key}`);
        },
      },
    );
  const settle = async () => {
    for (let i = 0; i < 10; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const live = editor();
  const liveEdit = live.edit("typed");
  stops.shift()?.(new Error("tts.errors.busy"));
  await liveEdit;
  assert.deepEqual(
    trace,
    ["error:tts.errors.busy"],
    "stop_failure_in_an_edit_keeps_its_reason: the named reason reaches error once, nothing is replaced",
  );

  trace.length = 0;
  const unnamed = editor();
  const unnamedEdit = unnamed.edit("typed");
  stops.shift()?.(new Error("worker crashed"));
  await unnamedEdit;
  assert.deepEqual(
    trace,
    ["error:tts.errors.generic"],
    "stop_failure_in_an_edit_keeps_its_reason: an unnamed stop failure stays generic",
  );

  trace.length = 0;
  const closing = editor();
  const closedEdit = closing.edit("typed");
  await closing.close();
  stops.shift()?.(new Error("tts.errors.busy"));
  await closedEdit;
  await settle();
  assert.deepEqual(
    trace,
    [],
    "stop_failure_in_an_edit_keeps_its_reason: no error after close()",
  );

  const reopened = editor();
  const first = reopened.edit("first");
  reopened.reopen({ ...view, epoch: view.epoch + 1 });
  const second = reopened.edit("second");
  stops.shift()?.(new Error("tts.errors.busy"));
  stops.shift()?.(new Error("tts.errors.audio"));
  await Promise.all([first, second]);
  await settle();
  assert.deepEqual(
    trace,
    ["error:tts.errors.audio"],
    "stop_failure_in_an_edit_keeps_its_reason: after reopen() only the second edit's failure applies",
  );

  trace.length = 0;
  const replaced = editor();
  const older = replaced.edit("older");
  replaced.reopen({ ...view, epoch: view.epoch + 2 });
  const newer = replaced.edit("newer");
  stops.shift()?.(new Error("tts.errors.busy"));
  stops.shift()?.();
  await Promise.all([older, newer]);
  await settle();
  assert.deepEqual(
    trace,
    ["replace:newer"],
    "stop_failure_in_an_edit_keeps_its_reason: after reopen() a stale failure never reports and the new edit lands",
  );
  console.log(
    "popup edit: stop failure keeps its reason, never after close or reopen passed",
  );
}
