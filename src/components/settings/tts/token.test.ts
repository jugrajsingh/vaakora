import assert from "node:assert/strict";
import { createTokenPresence, tokenEntry, groupModels } from "./token";
import { rowActions } from "./actions";
const presence = createTokenPresence();
let received = "";
let saveResult = true;
let fail = false;
const entry = tokenEntry(presence, async (value) => {
  received = value;
  if (fail) throw new Error("fixture");
  return saveResult;
});
entry.edit("fixture-token");
entry.show();
assert.equal(entry.snapshot().visible, true);
await entry.save();
assert.equal(received, "fixture-token");
assert.equal(
  presence.snapshot(),
  true,
  "successful backend result sets session presence",
);
assert.equal(entry.snapshot().draft, "", "save clears the password input");
assert.equal(entry.snapshot().visible, false);
const reopened = tokenEntry(presence, async () => true);
assert.equal(reopened.snapshot().draft, "", "navigation retains no password");
assert.equal(presence.snapshot(), true);
entry.edit("rejected-fixture");
fail = true;
assert.equal(await entry.save(), false);
assert.equal(entry.snapshot().error, "tts.errors.generic");
assert.equal(presence.snapshot(), true, "failed save preserves presence");
assert.equal(
  entry.snapshot().draft,
  "rejected-fixture",
  "failure keeps the draft",
);
fail = false;
saveResult = false;
await entry.clear();
assert.equal(received, "", "Clear sends blank token to backend");
assert.equal(
  presence.snapshot(),
  false,
  "backend false clears session presence",
);
assert.equal(entry.snapshot().draft, "");
entry.edit("unsaved-fixture");
entry.hide();
assert.equal(entry.snapshot().draft, "", "hiding erases an unsaved token");
assert.equal(
  createTokenPresence().snapshot(),
  false,
  "restart has no session presence",
);
const rows = [
  { id: "ready", downloaded: true, downloading: false },
  { id: "missing", downloaded: false, downloading: false },
  { id: "downloading", downloaded: true, downloading: true },
  { id: "active", downloaded: true, downloading: false },
];
const groups = groupModels(rows, ["active"]);
assert.deepEqual(
  groups.downloaded.map((row) => row.id),
  ["ready"],
);
assert.deepEqual(
  groups.available.map((row) => row.id),
  ["missing", "downloading", "active"],
);
console.log(
  "token entry, memory presence and model grouping assertions passed",
);

let downloadCalls = 0;
const ready = createTokenPresence();
const saver = tokenEntry(ready, async (value) => value.trim().length > 0);
const row = () =>
  rowActions(
    { id: "pocket-en", downloaded: false, needs_token: true },
    { selectedId: "other", downloadId: null, deletingId: null },
    { use: () => {}, delete: () => {}, download: () => downloadCalls++ },
    ready.snapshot(),
  );
row().download();
assert.equal(downloadCalls, 0);
saver.edit("fixture");
await saver.save();
row().download();
assert.equal(downloadCalls, 1, "async token save enables Pocket Download");
await saver.clear();
row().download();
assert.equal(downloadCalls, 1, "Clear disables Pocket Download");
saver.edit("   ");
await saver.save();
assert.equal(ready.snapshot(), false, "empty save respects backend absence");
let release!: (value: boolean) => void;
const pending = tokenEntry(
  ready,
  () =>
    new Promise((resolve) => {
      release = resolve;
    }),
);
pending.edit("fixture");
const save = pending.save();
assert.equal(pending.snapshot().pending, true);
assert.equal(
  ready.snapshot(),
  false,
  "presence changes only after save success",
);
release(true);
await save;
assert.equal(ready.snapshot(), true);

// collapse_clears_the_draft: regression, already true before the field moved into the details row.
{
  const entry = tokenEntry(createTokenPresence(), async () => true);
  entry.edit("fixture-draft");
  entry.show();
  entry.hide();
  assert.equal(entry.snapshot().draft, "", "collapse clears the draft");
  assert.equal(entry.snapshot().visible, false, "collapse hides the value");
}

// save_after_hide_updates_presence_only: regression, already true before the field moved.
{
  const late = createTokenPresence();
  let settle!: (value: boolean) => void;
  const entry = tokenEntry(
    late,
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  entry.edit("fixture-draft");
  const saving = entry.save();
  entry.hide();
  settle(true);
  assert.equal(await saving, true);
  assert.equal(late.snapshot(), true, "a late save still sets presence");
  assert.equal(entry.snapshot().draft, "");
  assert.equal(entry.snapshot().error, null, "no error on the closed row");
  assert.equal(entry.snapshot().pending, false);
}

// late_save_keeps_the_reopened_row_draft: the save lands after collapse, reopen and a new draft.
{
  const late = createTokenPresence();
  let settle!: (value: boolean) => void;
  const entry = tokenEntry(
    late,
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  entry.edit("first-fixture");
  const saving = entry.save();
  entry.hide();
  entry.edit("second-fixture");
  entry.show();
  settle(true);
  await saving;
  assert.equal(late.snapshot(), true, "the late save sets presence");
  assert.equal(
    entry.snapshot().draft,
    "second-fixture",
    "the new draft survives the late save",
  );
  assert.equal(entry.snapshot().visible, true, "so does the Show toggle");
  assert.equal(entry.snapshot().pending, false);
}

// late_failure_shows_nothing_on_the_reopened_row
{
  const late = createTokenPresence();
  let refuse!: (reason: Error) => void;
  const entry = tokenEntry(
    late,
    () =>
      new Promise((_, reject) => {
        refuse = reject;
      }),
  );
  entry.edit("first-fixture");
  const saving = entry.save();
  entry.hide();
  entry.edit("second-fixture");
  refuse(new Error("fixture"));
  assert.equal(await saving, false);
  assert.equal(entry.snapshot().error, null, "no error on the reopened row");
  assert.equal(entry.snapshot().draft, "second-fixture");
  assert.equal(entry.snapshot().pending, false);
  assert.equal(late.snapshot(), false, "a failed late save leaves presence");
}
