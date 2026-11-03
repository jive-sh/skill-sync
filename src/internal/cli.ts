import { spawn } from "node:child_process";
import { Data, Effect, Schedule, Stdio, Stream, pipe } from "effect";
import { Cli, upgrade } from "jive-abstract-library";
import { name, version } from "../../package.json";
import { detectFolders } from "./agents";
import { loadSettings } from "./config";
import { DaemonFailed } from "./control";
import { DaemonControl, type DaemonError, type IDaemonControl } from "./daemon-control/interface";
import { addableSkills, formatSkillCopies, skillCopies } from "./local-skills";

/**
 * The CLI that accompanies the daemon: `login`, `logout`, `list`, `add`, `show`, `upgrade` and `version`. Which
 * folders sync is chosen on the dashboard; skills are ticked there too, or added with `add` by the agent that
 * wrote one.
 *
 * The daemon owns the sync token and keeps it in `~/.jive/skill-sync-token.json`. `login`, `logout`, `list` and
 * `add` are requests to it over the control socket; the token goes from the browser straight to the daemon and
 * never through here. Tab after `show` lists the synced skills and Tab after `add` the skills that could be
 * added, both asked of the daemon when Tab is pressed.
 */

const DASHBOARD = "https://skill-sync.jive.sh/";

/** How long Tab waits for the daemon before showing that it did not answer; it never starts one. */
const TAB_TIME_LIMIT_SECONDS = 3;

/** How often a command asks again after starting the daemon, and how many times. */
const RETRY_INTERVAL = "500 millis";
const RETRIES = 20;

class SkillNotOnThisMachine extends Data.TaggedError("SkillNotOnThisMachine")<{ readonly message: string }> {}
class UpgradeFailed extends Data.TaggedError("UpgradeFailed")<{ readonly message: string }> {}

export const skillSync = Cli.make("skill-sync", {
  login: Cli.command({
    description: "sign this machine in with your passkey in the browser; it stays signed in until you log out",
    *run() {
      const machine = yield* withDaemon((daemon) => daemon.login((url) => pipe(
        Effect.log(`Opening ${url}`),
        Effect.andThen(Effect.sync(() => openBrowser(url))),
      )));
      yield* Effect.log(`Signed in. ${machine} is syncing; choose what syncs at ${DASHBOARD}`);
    },
  }),

  logout: Cli.command({
    description: "revoke this machine's token and stop syncing until the next login",
    *run() {
      const revoked = yield* withDaemon((daemon) => daemon.logout());
      yield* Effect.log(revoked ? "Signed out; the token is revoked." : "Signed out locally; the server could not be reached to revoke the token.");
    },
  }),

  list: Cli.command({
    description: "list the skills that sync, as the server holds them; needs this machine signed in",
    *run() {
      const skills = yield* withDaemon((daemon) => daemon.listSyncedSkills());
      if (skills.length === 0) {
        yield* Effect.log(`No skills sync yet; tick them at ${DASHBOARD}`);
        return;
      }
      const width = Math.max(...skills.map((skill) => skill.name.length));
      for (const skill of skills) {
        const detail = skill.editedAt === null
          ? "no files yet"
          : `${skill.files} ${skill.files === 1 ? "file" : "files"}, last edited ${new Date(skill.editedAt).toLocaleString()} on ${skill.editedBy}`;
        yield* Effect.log(`${skill.name.padEnd(width)}  ${detail}`);
      }
    },
  }),

  add: Cli.choose({
    description: "put a skill meant for every project on the synced list; give its folder name, which must match the name in its SKILL.md. It must be in a folder skill-sync syncs, with a valid SKILL.md. Repeating it changes nothing",
    *choices() {
      const synced = (yield* listForTab).map((skill) => skill.name);
      return addableSkills({ folders: detectFolders(), exclude: loadSettings()?.exclude ?? [], synced });
    },
    next: (skill) => Cli.command({
      description: `put ${skill} on the synced list`,
      *run() {
        const result = yield* withDaemon((daemon) => daemon.addSkill(skill));
        yield* Effect.log(result.added ? `Added ${skill} to the synced list.` : `${skill} was already on the synced list.`);
        if (result.syncingFolders.length === 0) {
          yield* Effect.log(`None of the folders holding it on this machine (${result.folders.join(", ")}) is ticked at ${DASHBOARD}, so its files upload once one is.`);
        }
      },
    }),
  }),

  show: Cli.choose({
    description: "print a synced skill's description and where its copies are on this machine",
    *choices() {
      return (yield* listForTab).map((skill) => skill.name);
    },
    next: (skill) => Cli.command({
      description: `print ${skill}'s description and where its copies are on this machine`,
      *run() {
        const folders = detectFolders();
        const copies = skillCopies({ skill, folders });
        if (copies.length === 0) {
          return yield* new SkillNotOnThisMachine({
            message: `no skills folder skill-sync syncs has a "${skill}" folder; it looked in ${folders.join(", ") || "no folders"}`,
          });
        }
        yield* Effect.log(formatSkillCopies(copies));
      },
    }),
  }),

  upgrade: Cli.command({
    description: "upgrade skill-sync to the latest version with the package manager that installed it",
    *run() {
      yield* pipe(upgrade({ packageName: name }), Effect.mapError((message) => new UpgradeFailed({ message: `Upgrade failed: ${message}` })));
    },
  }),

  version: Cli.command({
    description: "print the version of skill-sync installed here",
    *run() {
      yield* Effect.log(version);
    },
  }),
});

/**
 * Runs the CLI on the process's arguments. A command that fails prints why on stderr, alone, and exits 1; usage
 * errors are the library's (`Cli.CliError`, exit 2).
 */
export function runSkillSync() {
  return pipe(
    Cli.run(skillSync, { version }),
    Effect.catchTags({
      DaemonFailed: report,
      SkillNotOnThisMachine: report,
      UpgradeFailed: report,
    }),
  );
}


function report(error: { readonly message: string }): Effect.Effect<never, Cli.CliError, Stdio.Stdio> {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Effect.orDie(Stream.run(Stream.make(`${error.message}\n`), stdio.stderr()));
    return yield* new Cli.CliError({ message: error.message, exitCode: 1 });
  });
}

/**
 * Runs `use` against the daemon. If none is listening (stopped, or never started since the install) this
 * package's registered daemon is started and `use` is tried again for about ten seconds. Tab never comes here.
 */
function withDaemon<A>(use: (daemon: IDaemonControl) => Effect.fn.Return<A, DaemonError>): Effect.Effect<A, DaemonFailed, DaemonControl> {
  return Effect.gen(function* () {
    const daemon = yield* DaemonControl;
    const attempt = Effect.gen(() => use(daemon));
    return yield* pipe(
      attempt,
      Effect.catchTag("DaemonNotRunning", () => pipe(
        Effect.gen(() => daemon.startDaemon()),
        Effect.andThen(Effect.sleep(RETRY_INTERVAL)),
        Effect.andThen(Effect.retry(attempt, {
          schedule: Schedule.spaced(RETRY_INTERVAL),
          times: RETRIES,
          while: (error) => error._tag === "DaemonNotRunning",
        })),
        Effect.catchTag("DaemonNotRunning", (error) =>
          Effect.fail(new DaemonFailed({ message: `${error.message}. Reinstall skill-sync to register its daemon.` }))),
      )),
    );
  });
}

/**
 * The synced list for Tab: asked of the daemon, which must already be running, within a time limit, so Tab shows
 * why it has nothing to offer rather than hanging.
 */
const listForTab = pipe(
  Effect.gen(function* () {
    return yield* (yield* DaemonControl).listSyncedSkills();
  }),
  Effect.timeoutOrElse({
    duration: `${TAB_TIME_LIMIT_SECONDS} seconds`,
    orElse: () => Effect.fail(new DaemonFailed({ message: `the skill-sync daemon did not answer within ${TAB_TIME_LIMIT_SECONDS} seconds` })),
  }),
);

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}
