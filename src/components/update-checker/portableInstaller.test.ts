// Standalone assert check (no JS unit-test runner in this repo). Run with:
//   bun src/components/update-checker/portableInstaller.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  resolvePortableInstallerUrl,
  PORTABLE_RELEASES_URL,
} from "./portableInstaller";
import {
  runInstall,
  type InstallDeps,
  type UpdateHandle,
} from "./installUpdate";
import {
  beginInstall,
  endInstall,
  getUpdaterState,
  mountCheck,
  requestManualCheck,
  setInstallProgress,
  subscribeManualCheck,
  subscribeUpdater,
  takeManualCheck,
  updateChecksAllowed,
} from "./updaterStore";

const X64_SETUP =
  "https://github.com/jugrajsingh/vaakora/releases/download/v0.9.5/Vaakora_0.9.5_x64-setup.exe";
const ARM64_SETUP =
  "https://github.com/jugrajsingh/vaakora/releases/download/v0.9.5/Vaakora_0.9.5_arm64-setup.exe";

// Trimmed copy of the real latest.json served from the updater endpoint.
const manifest = {
  version: "0.9.5",
  platforms: {
    "windows-x86_64-nsis": { url: X64_SETUP, signature: "…" },
    "windows-x86_64-msi": {
      url: "https://github.com/jugrajsingh/vaakora/releases/download/v0.9.5/Vaakora_0.9.5_x64_en-US.msi",
    },
    "windows-aarch64-nsis": { url: ARM64_SETUP, signature: "…" },
    "darwin-aarch64": {
      url: "https://github.com/jugrajsingh/vaakora/releases/download/v0.9.5/Vaakora_aarch64.app.tar.gz",
    },
  },
};

// x64 Windows -> the x64 NSIS asset, pinned to the release tag
assert.equal(
  resolvePortableInstallerUrl(manifest, "windows", "x86_64"),
  X64_SETUP,
);

// arm64 Windows -> the arm64 NSIS asset
assert.equal(
  resolvePortableInstallerUrl(manifest, "windows", "aarch64"),
  ARM64_SETUP,
);

// no manifest (check() failed or returned no update) -> releases page fallback
assert.equal(
  resolvePortableInstallerUrl(undefined, "windows", "x86_64"),
  PORTABLE_RELEASES_URL,
);

// no NSIS bundle for this arch -> releases page fallback
assert.equal(
  resolvePortableInstallerUrl(manifest, "windows", "x86"),
  PORTABLE_RELEASES_URL,
);

// non-Windows portable install -> releases page, never a Windows .exe
assert.equal(
  resolvePortableInstallerUrl(manifest, "macos", "aarch64"),
  PORTABLE_RELEASES_URL,
);

// malformed manifest -> releases page fallback
assert.equal(
  resolvePortableInstallerUrl({ platforms: "nope" }, "windows", "x86_64"),
  PORTABLE_RELEASES_URL,
);

// update_gate_refuses_unless_enabled_and_known
assert.equal(updateChecksAllowed(true, false), true);
for (const [stored, locked] of [
  [true, true],
  [true, null],
  [false, false],
  [undefined, false],
  [undefined, null],
] as [boolean | undefined, boolean | null][]) {
  assert.equal(
    updateChecksAllowed(stored, locked),
    false,
    `${stored}/${locked}`,
  );
}
// The component reads the stored switch only through the gate.
const checkerSource = readFileSync(
  new URL("./UpdateChecker.tsx", import.meta.url),
  "utf8",
);
assert.ok(checkerSource.includes("updateChecksAllowed("), "gate is called");
assert.equal(
  checkerSource
    .replace(
      /updateChecksAllowed\(\s*[\w.]*settings\?\.update_checks_enabled,/gu,
      "",
    )
    .includes("update_checks_enabled"),
  false,
  "update_checks_enabled is read only inside the gate call",
);

// The component hands the install to the seam with the live permission getter,
// and takes tray requests from the store.
assert.ok(
  /const \{ settings, updateChecksLocked \} = useSettingsStore\.getState\(\);/u.test(
    checkerSource,
  ),
  "the permission getter reads the live store",
);
assert.ok(
  /runInstall\(\{\s*allowed: currentUpdateChecksAllowed,/u.test(checkerSource),
  "installUpdate runs the seam with the getter",
);
assert.ok(
  /subscribeManualCheck\(\(\) => \{\s*if \(takeManualCheck\(\)\) handleManualUpdateCheck\(\);/u.test(
    checkerSource,
  ),
  "the checker takes tray requests from the store",
);
assert.ok(
  !checkerSource.includes("check-for-updates"),
  "the checker has no event listener of its own",
);
assert.ok(
  /const mountPlan = mountCheck\(\);[\s\S]*?if \(mountPlan !== "none"\) \{[\s\S]*?checkForUpdates\(\);/u.test(
    checkerSource,
  ),
  "the mount check skips the automatic check while installing",
);

// updater_store_install_survives_remount: a remount reads the live install,
// never starts a second one and never checks.
assert.equal(beginInstall(), true);
assert.equal(beginInstall(), false, "a second Install is refused");
setInstallProgress(40);
assert.deepEqual(getUpdaterState(), { installing: true, progress: 40 });
requestManualCheck();
assert.equal(mountCheck(), "none", "no check while installing");
endInstall();
assert.deepEqual(getUpdaterState(), { installing: false, progress: 0 });
assert.equal(mountCheck(), "auto", "the pending request died with the install");
let notified = 0;
const unsubscribe = subscribeUpdater(() => (notified += 1));
assert.equal(beginInstall(), true);
setInstallProgress(10);
endInstall();
unsubscribe();
assert.equal(notified, 3, "subscribers hear every change");

// updater_store_tray_check_reaches_a_later_mount: the tray event fires before
// About mounts; the flag carries it to the mount exactly once.
assert.equal(mountCheck(), "auto");
requestManualCheck();
assert.equal(mountCheck(), "manual", "flag consumed by the mount");
assert.equal(mountCheck(), "auto", "and only once");

// updater_store_mounted_checker_takes_the_request: a subscribed checker is told
// when the flag goes up and consumes it once; never during an install.
let taken: boolean[] = [];
const unsubscribeManual = subscribeManualCheck(() =>
  taken.push(takeManualCheck()),
);
requestManualCheck();
assert.deepEqual(taken, [true], "the subscriber takes the request");
assert.equal(mountCheck(), "auto", "nothing is left pending");
assert.equal(beginInstall(), true);
taken = [];
requestManualCheck();
assert.deepEqual(taken, [false], "no manual check during an install");
endInstall();
assert.equal(mountCheck(), "auto", "the refused request is dropped");
unsubscribeManual();
requestManualCheck();
assert.deepEqual(taken, [false], "an unsubscribed checker hears nothing");
assert.equal(mountCheck(), "manual", "the flag waits for the next mount");

// install_action_rechecks_permission_after_each_await
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function installHarness(allowedAtStart = true) {
  const calls: string[] = [];
  const state = { allowed: allowedAtStart };
  const update: UpdateHandle = {
    downloadAndInstall: async (onEvent) => {
      calls.push("downloadAndInstall");
      onEvent({ event: "Started", data: { contentLength: 200 } });
      onEvent({ event: "Progress", data: { chunkLength: 50 } });
      calls.push(`progress=${getUpdaterState().progress}`);
      await gate.download.promise;
    },
  };
  const gate = {
    isPortable: deferred<boolean>(),
    check: deferred<UpdateHandle | null>(),
    download: deferred<void>(),
  };
  const deps: InstallDeps = {
    allowed: () => state.allowed,
    isPortable: () => {
      calls.push("isPortable");
      return gate.isPortable.promise;
    },
    check: () => {
      calls.push("check");
      return gate.check.promise;
    },
    relaunch: async () => {
      calls.push("relaunch");
    },
    showPortableDialog: () => calls.push("dialog"),
  };
  return { calls, state, update, gate, deps };
}

{
  const refused = installHarness(false);
  await runInstall(refused.deps);
  assert.deepEqual(refused.calls, [], "refused at the start");
}
{
  const h = installHarness();
  const run = runInstall(h.deps);
  h.state.allowed = false;
  h.gate.isPortable.resolve(false);
  h.gate.check.resolve(null);
  await run;
  assert.deepEqual(h.calls, ["isPortable"], "no check() after isPortable");
  assert.equal(getUpdaterState().installing, false);
}
{
  const h = installHarness();
  const run = runInstall(h.deps);
  h.state.allowed = false;
  h.gate.isPortable.resolve(true);
  await run;
  assert.deepEqual(h.calls, ["isPortable"], "no portable dialog when off");
}
{
  const h = installHarness();
  const run = runInstall(h.deps);
  h.gate.isPortable.resolve(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getUpdaterState().installing, true, "lock held across check()");
  assert.equal(beginInstall(), false, "a second install is refused");
  h.state.allowed = false;
  h.gate.check.resolve(h.update);
  await run;
  assert.deepEqual(
    h.calls,
    ["isPortable", "check"],
    "no downloadAndInstall after check()",
  );
  assert.equal(getUpdaterState().installing, false, "lock released on refusal");
}
{
  const h = installHarness();
  const run = runInstall(h.deps);
  h.gate.isPortable.resolve(false);
  await Promise.resolve();
  await Promise.resolve();
  h.gate.check.resolve(h.update);
  h.gate.download.resolve();
  await run;
  assert.deepEqual(h.calls, [
    "isPortable",
    "check",
    "downloadAndInstall",
    "progress=25",
    "relaunch",
  ]);
  assert.deepEqual(getUpdaterState(), { installing: false, progress: 0 });
}
{
  const h = installHarness();
  const run = runInstall(h.deps);
  h.gate.isPortable.resolve(false);
  h.gate.check.resolve(h.update);
  await new Promise((tick) => setTimeout(tick, 0));
  assert.deepEqual(
    h.calls,
    ["isPortable", "check", "downloadAndInstall", "progress=25"],
    "the authorised download is running",
  );
  assert.equal(
    getUpdaterState().installing,
    true,
    "lock held while downloading",
  );
  h.state.allowed = false;
  h.gate.download.resolve();
  await run;
  assert.deepEqual(
    h.calls,
    ["isPortable", "check", "downloadAndInstall", "progress=25"],
    "no relaunch after the switch is turned off during the download",
  );
  assert.equal(getUpdaterState().installing, false, "lock released on refusal");
}
{
  const h = installHarness();
  const run = runInstall(h.deps);
  h.gate.isPortable.resolve(true);
  await run;
  assert.deepEqual(
    h.calls,
    ["isPortable", "dialog"],
    "portable shows the dialog",
  );
}

console.log("portableInstaller: all assertions passed");
