import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ReadHistoryEntry, Result } from "@/bindings";
import {
  createHistoryActions,
  createSettingSetters,
  shownEntry,
  type HistoryDependencies,
} from "./actions";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const entry = { id: 7 } as ReadHistoryEntry;

function harness(patch: Partial<HistoryDependencies> = {}) {
  const calls: string[] = [];
  const deps: HistoryDependencies = {
    load: async () => {
      calls.push("load");
      return [entry];
    },
    clear: async () => {
      calls.push("clear");
      return 1;
    },
    confirm: async (count) => {
      calls.push(`confirm ${count}`);
      return true;
    },
    setLimit: async (limit) => {
      calls.push(`limit ${limit}`);
    },
    setRetention: async (retention) => {
      calls.push(`retention ${retention}`);
    },
    setEntries: (entries) => calls.push(`entries ${entries.length}`),
    setClearing: (clearing) => calls.push(`clearing ${clearing}`),
    setError: (key) => calls.push(`error ${key}`),
    ...patch,
  };
  return { calls, actions: createHistoryActions(deps) };
}

describe("history actions", () => {
  it("load shows the stored entries", async () => {
    const { calls, actions } = harness();
    assert.equal((await actions.load())?.length, 1);
    assert.deepEqual(calls, ["error null", "load", "entries 1"]);
  });
  it("a failed load shows the generic error and keeps the entries", async () => {
    const { calls, actions } = harness({
      load: async () => {
        throw new Error("no");
      },
    });
    assert.equal(await actions.load(), null);
    assert.deepEqual(calls, ["error null", "error tts.errors.generic"]);
  });
  it("clear asks first, then clears and reloads", async () => {
    const { calls, actions } = harness();
    await actions.clear(3);
    assert.deepEqual(calls, [
      "clearing true",
      "error null",
      "confirm 3",
      "clear",
      "error null",
      "load",
      "entries 1",
      "clearing false",
    ]);
  });
  it("clear does nothing when the owner declines", async () => {
    const { calls, actions } = harness({ confirm: async () => false });
    await actions.clear(3);
    assert.ok(!calls.includes("clear"), calls.join());
    assert.equal(calls[calls.length - 1], "clearing false");
  });
  it("a failed clear is reported and does not reload", async () => {
    const { calls, actions } = harness({
      clear: async () => {
        throw new Error("no");
      },
    });
    await actions.clear(3);
    assert.ok(calls.includes("error tts.errors.generic"), calls.join());
    assert.ok(!calls.includes("load"), calls.join());
    assert.equal(calls[calls.length - 1], "clearing false");
  });
  it("a second clear while one runs is ignored", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, actions } = harness({
      confirm: async () => {
        await gate;
        return true;
      },
    });
    const first = actions.clear(1);
    await actions.clear(1);
    release();
    await first;
    assert.equal(calls.filter((call) => call === "clear").length, 1);
  });
});

/** A setting change that finishes only when `release` is called. */
function deferred() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

describe("history settings", () => {
  it("retention_change_reloads_after_prune", async () => {
    const { gate, release } = deferred();
    const { calls, actions } = harness({
      setRetention: async (retention) => {
        calls.push(`retention ${retention}`);
        await gate;
        calls.push("pruned");
      },
    });
    const change = actions.changeRetention("keep_nothing");
    await Promise.resolve();
    assert.ok(!calls.includes("load"), calls.join());
    release();
    await change;
    assert.deepEqual(calls, [
      "retention keep_nothing",
      "pruned",
      "error null",
      "load",
      "entries 1",
    ]);
  });
  it("a limit change reloads once the new limit is applied", async () => {
    const { gate, release } = deferred();
    const { calls, actions } = harness({
      setLimit: async (limit) => {
        calls.push(`limit ${limit}`);
        await gate;
        calls.push("pruned");
      },
    });
    const change = actions.changeLimit(2);
    await Promise.resolve();
    assert.ok(!calls.includes("load"), calls.join());
    release();
    await change;
    assert.deepEqual(calls, [
      "limit 2",
      "pruned",
      "error null",
      "load",
      "entries 1",
    ]);
  });
  it("reloads even when the setting could not be saved", async () => {
    const { calls, actions } = harness({
      setLimit: async () => {
        throw new Error("no");
      },
    });
    await actions.changeLimit(2);
    assert.ok(calls.includes("load"), calls.join());
    assert.equal(calls[calls.length - 1], "error tts.errors.generic");
  });
});

describe("history setting adapter", () => {
  const refused = { status: "error", error: "tts.errors.starting" } as const;
  const accepted = { status: "ok", data: null } as const;
  function wired(result: Result<null, string>) {
    const calls: string[] = [];
    const setters = createSettingSetters({
      setLimit: async (limit) => {
        calls.push(`command limit ${limit}`);
        return result;
      },
      setRetention: async (retention) => {
        calls.push(`command retention ${retention}`);
        return result;
      },
      refresh: async () => {
        calls.push("refresh settings");
      },
    });
    const { actions } = harness({
      ...setters,
      load: async () => {
        calls.push("load");
        return [entry];
      },
      setError: (key) => calls.push(`error ${key}`),
    });
    return { calls, actions };
  }
  it("history_setting_command_error_survives_successful_reload", async () => {
    const { calls, actions } = wired(refused);
    await actions.changeLimit(3);
    assert.deepEqual(calls, [
      "command limit 3",
      "refresh settings",
      "error null",
      "load",
      "error tts.errors.starting",
    ]);
  });
  it("shows a refused retention change the same way", async () => {
    const { calls, actions } = wired(refused);
    await actions.changeRetention("keep_nothing");
    assert.equal(calls[calls.length - 1], "error tts.errors.starting");
    assert.ok(calls.includes("load"), calls.join());
  });
  it("shows no error when the command succeeds", async () => {
    const { calls, actions } = wired(accepted);
    await actions.changeLimit(3);
    assert.deepEqual(calls, [
      "command limit 3",
      "refresh settings",
      "error null",
      "load",
    ]);
  });
  it("shows the generic error for a message that is not a translation key", async () => {
    const { calls, actions } = wired({ status: "error", error: "disk full" });
    await actions.changeLimit(3);
    assert.equal(calls[calls.length - 1], "error tts.errors.generic");
  });
});

describe("shownEntry", () => {
  const rows = [{ id: 9 }, { id: 4 }] as ReadHistoryEntry[];
  it("shows the chosen read while it exists", () => {
    assert.equal(shownEntry(rows, 4)?.id, 4);
  });
  it("falls back to the newest read when the chosen one was pruned", () => {
    assert.equal(shownEntry(rows, 3)?.id, 9);
    assert.equal(shownEntry(rows, null)?.id, 9);
  });
  it("shows nothing for an empty or unloaded history", () => {
    assert.equal(shownEntry([], 4), undefined);
    assert.equal(shownEntry(null, null), undefined);
  });
});
