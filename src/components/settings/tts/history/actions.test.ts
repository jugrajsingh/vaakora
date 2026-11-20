import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ReadHistoryEntry, Result } from "@/bindings";
import {
  createHistoryActions,
  createRetentionActions,
  createSettingSetters,
  sameReadCount,
  type HistoryDependencies,
  type RetentionDependencies,
} from "./actions";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const entry = { id: 7 } as ReadHistoryEntry;
const older = { id: 6 } as ReadHistoryEntry;

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
    cleared: () => calls.push("cleared"),
    setEntries: (entries) => calls.push(`entries ${entries.length}`),
    setError: (key) => calls.push(`error ${key}`),
    ...patch,
  };
  return { calls, actions: createHistoryActions(deps) };
}

function retentionHarness(patch: Partial<RetentionDependencies> = {}) {
  const calls: string[] = [];
  const deps: RetentionDependencies = {
    load: async () => {
      calls.push("load");
      return [entry];
    },
    setLimit: async (limit) => {
      calls.push(`limit ${limit}`);
    },
    setRetention: async (retention) => {
      calls.push(`retention ${retention}`);
    },
    setEntries: (entries) => calls.push(`entries ${entries.length}`),
    setError: (key) => calls.push(`error ${key}`),
    ...patch,
  };
  return { calls, actions: createRetentionActions(deps) };
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
  it("read_count_reloads_the_list", async () => {
    const { calls, actions } = harness({
      load: async () => {
        calls.push("load");
        return [entry, older];
      },
    });
    assert.deepEqual(await actions.count(), { count: 2, newest: 7 });
    assert.deepEqual(calls, ["error null", "load", "entries 2"]);
    const empty = harness({ load: async () => [] });
    assert.deepEqual(await empty.actions.count(), { count: 0, newest: null });
    const failing = harness({
      load: async () => {
        throw new Error("no");
      },
    });
    assert.equal(await failing.actions.count(), null);
    assert.deepEqual(failing.calls, ["error null", "error tts.errors.generic"]);
    assert.equal(
      sameReadCount({ count: 2, newest: 7 }, { count: 2, newest: 7 }),
      true,
    );
    assert.equal(
      sameReadCount({ count: 2, newest: 7 }, { count: 3, newest: 8 }),
      false,
    );
    assert.equal(
      sameReadCount({ count: 2, newest: 7 }, { count: 2, newest: 8 }),
      false,
      "one read added and the oldest pruned asks again",
    );
  });
  it("read_clear_clears_then_reloads", async () => {
    const { calls, actions } = harness();
    await actions.clear();
    assert.deepEqual(calls, [
      "clear",
      "cleared",
      "error null",
      "load",
      "entries 1",
    ]);
  });
  it("a failed clear is reported and does not reload", async () => {
    const { calls, actions } = harness({
      clear: async () => {
        throw new Error("no");
      },
    });
    await actions.clear();
    assert.ok(calls.includes("error tts.errors.generic"), calls.join());
    assert.ok(!calls.includes("load"), calls.join());
    assert.ok(!calls.includes("cleared"), "nothing was cleared");
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
    const { calls, actions } = retentionHarness({
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
    const { calls, actions } = retentionHarness({
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
    const { calls, actions } = retentionHarness({
      setLimit: async () => {
        throw new Error("no");
      },
    });
    await actions.changeLimit(2);
    assert.ok(calls.includes("load"), calls.join());
    assert.equal(calls[calls.length - 1], "error tts.errors.generic");
  });
});

describe("retention actions", () => {
  function recorded(patch: Partial<RetentionDependencies> = {}) {
    const calls: string[] = [];
    const actions = createRetentionActions({
      load: async () => {
        calls.push("load");
        return [entry];
      },
      setLimit: async (limit) => {
        calls.push(`limit ${limit}`);
      },
      setRetention: async (retention) => {
        calls.push(`retention ${retention}`);
      },
      setEntries: (entries) => calls.push(`entries ${entries.length}`),
      setError: (key) => calls.push(`error ${key}`),
      ...patch,
    });
    return { calls, actions };
  }
  it("retention_actions_load_and_apply_without_clear", async () => {
    const { calls, actions } = recorded();
    assert.ok(!("clear" in actions), "no clear in the retention actions");
    await actions.changeLimit(3);
    assert.deepEqual(calls, ["limit 3", "error null", "load", "entries 1"]);
    assert.equal(calls.filter((call) => call === "load").length, 1);
    const refused = recorded({
      setRetention: async () => {
        throw new Error("tts.errors.busy");
      },
    });
    await refused.actions.changeRetention("keep_nothing");
    assert.deepEqual(refused.calls, [
      "error null",
      "load",
      "entries 1",
      "error tts.errors.busy",
    ]);
    const failing = recorded({
      load: async () => {
        throw new Error("no");
      },
    });
    assert.equal(await failing.actions.load(), null);
    assert.deepEqual(failing.calls, ["error null", "error tts.errors.generic"]);
  });
  it("the history actions are load, count and clear, without the retention changes", () => {
    const { actions } = harness();
    assert.deepEqual(Object.keys(actions).sort(), ["clear", "count", "load"]);
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
    const { actions } = retentionHarness({
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
