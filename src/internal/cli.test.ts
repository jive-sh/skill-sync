import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Logger, Option, Sink, Stdio, pipe } from "effect";
import { Cli } from "jive-abstract-library";
import { runSkillSync } from "./cli";
import { DaemonFailed, DaemonNotRunning } from "./control";
import { DaemonControl, type IDaemonControl } from "./daemon-control/interface";
import type { ListedSkill } from "./wire";

/**
 * The CLI against a fake daemon. The live daemon, real Tab in zsh, and `show` and `add` reading the real skills
 * folders are not covered here; their disk logic is tested in `local-skills.test.ts`.
 */

const listed: ReadonlyArray<ListedSkill> = [
  { name: "jive", files: 0, editedAt: null, editedBy: null },
  { name: "senior-swe", files: 1, editedAt: Date.UTC(2026, 10, 1), editedBy: "rose" },
];

function fakeDaemon(overrides: Partial<IDaemonControl> = {}): IDaemonControl {
  return {
    *login() { return "rose"; },
    *logout() { return true; },
    *listSyncedSkills() { return listed; },
    *addSkill() { return { added: true, folders: ["/home/.claude/skills"], syncingFolders: [] }; },
    *startDaemon() {},
    ...overrides,
  };
}

async function invoke(args: ReadonlyArray<string>, daemon: IDaemonControl = fakeDaemon()) {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const collect = (into: Array<string>) => () =>
    Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => { into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); }));
  // Stands in for Cli.terminalLogger, which prints an info line as the message alone on stdout.
  const logger = Logger.layer([Logger.make(({ message }) => {
    stdout.push(`${(Array.isArray(message) ? message : [message]).join(" ")}\n`);
  })]);
  const exit = await Effect.runPromise(pipe(
    runSkillSync(),
    Effect.provide(Layer.mergeAll(
      Stdio.layerTest({ args: Effect.succeed(args), stdout: collect(stdout), stderr: collect(stderr) }),
      Layer.succeed(DaemonControl, daemon),
      logger,
    )),
    Effect.exit,
  ));
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: exitCodeOf(exit) };
}

const exitCodeOf = (exit: Exit.Exit<void, unknown>) =>
  Exit.isSuccess(exit) ? 0 : Option.match(Exit.findErrorOption(exit), {
    onNone: () => -1,
    onSome: (error) => error instanceof Cli.CliError ? error.exitCode : 1,
  });

test("login prints the machine that signed in", async () => {
  expect(await invoke(["login"])).toEqual({
    stdout: "Signed in. rose is syncing; choose what syncs at https://skill-sync.jive.sh/\n",
    stderr: "",
    exitCode: 0,
  });
});

test("logout says whether the server revoked the token", async () => {
  expect((await invoke(["logout"])).stdout).toBe("Signed out; the token is revoked.\n");
  expect((await invoke(["logout"], fakeDaemon({ *logout() { return false; } }))).stdout)
    .toBe("Signed out locally; the server could not be reached to revoke the token.\n");
});

test("list lines up the names and says when a skill has no files yet", async () => {
  const { stdout } = await invoke(["list"]);
  const [first, second] = stdout.split("\n");
  expect(first).toBe("jive        no files yet");
  expect(second).toStartWith("senior-swe  1 file, last edited ");
  expect(second).toEndWith(" on rose");
  expect((await invoke(["list"], fakeDaemon({ *listSyncedSkills() { return []; } }))).stdout)
    .toBe("No skills sync yet; tick them at https://skill-sync.jive.sh/\n");
});

test("add says what changed, and when no folder holding the skill is ticked", async () => {
  expect((await invoke(["add", "release-notes"])).stdout).toBe(
    "Added release-notes to the synced list.\n"
    + "None of the folders holding it on this machine (/home/.claude/skills) is ticked at https://skill-sync.jive.sh/, so its files upload once one is.\n",
  );
  const already = fakeDaemon({ *addSkill() { return { added: false, folders: ["/a"], syncingFolders: ["/a"] }; } });
  expect((await invoke(["add", "jive"], already)).stdout).toBe("jive was already on the synced list.\n");
});

test("a request the daemon refuses prints its reason alone on stderr and exits 1", async () => {
  const refusing = fakeDaemon({
    *addSkill() { return yield* new DaemonFailed({ message: "this machine is signed out; run `skill-sync login` first" }); },
  });
  expect(await invoke(["add", "jive"], refusing)).toEqual({
    stdout: "",
    stderr: "this machine is signed out; run `skill-sync login` first\n",
    exitCode: 1,
  });
});

test("a command starts the daemon when none is running and asks again until it answers", async () => {
  let started = 0;
  let asked = 0;
  const starting = fakeDaemon({
    *startDaemon() { started++; },
    *listSyncedSkills() {
      asked++;
      if (asked < 3) return yield* new DaemonNotRunning({ message: "the skill-sync daemon is not running" });
      return listed;
    },
  });
  const { stdout, exitCode } = await invoke(["list"], starting);
  expect({ started, asked, exitCode }).toEqual({ started: 1, asked: 3, exitCode: 0 });
  expect(stdout).toStartWith("jive ");
});

test("Tab after show lists the synced skills, filtered by what is typed", async () => {
  expect((await invoke(["--compgen", "show", ""])).stdout).toBe("jive\nsenior-swe\n");
  expect((await invoke(["--compgen", "show", "s"])).stdout).toBe("senior-swe\n");
});

test("Tab never starts the daemon: with none running it shows why, and offers nothing", async () => {
  let started = 0;
  const stopped = fakeDaemon({
    *startDaemon() { started++; },
    *listSyncedSkills() { return yield* new DaemonNotRunning({ message: "the skill-sync daemon is not running (ENOENT)" }); },
  });
  const { stdout, stderr, exitCode } = await invoke(["--compgen", "show", ""], stopped);
  expect({ stdout, stderr, exitCode, started }).toEqual({
    stdout: "",
    stderr: "\nskill-sync: could not list choices: the skill-sync daemon is not running (ENOENT)\n",
    exitCode: 0,
    started: 0,
  });
});

test("Tab gives up on a daemon that does not answer within 3 seconds", async () => {
  const silent = fakeDaemon({ *listSyncedSkills() { return yield* Effect.never; } });
  const started = Date.now();
  const { stderr } = await invoke(["--compgen", "show", ""], silent);
  expect(stderr).toBe("\nskill-sync: could not list choices: the skill-sync daemon did not answer within 3 seconds\n");
  expect(Date.now() - started).toBeLessThan(5_000);
}, 10_000);
