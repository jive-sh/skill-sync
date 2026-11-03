import { spawnSync } from "node:child_process";
import { Effect, Layer, Option, Stream, pipe } from "effect";
import { daemonStatuses } from "jive-abstract-library";
import { name } from "../../../package.json";
import { DaemonFailed, requestEvents, type ControlEvent, type ControlRequest } from "../control";
import type { ListedSkill } from "../wire";
import { DaemonControl, type AddedSkill, type DaemonError, type IDaemonControl } from "./interface";

class DaemonControlImpl implements IDaemonControl {
  *login(openSignInPage: (url: string) => Effect.Effect<void>): Effect.fn.Return<string, DaemonError> {
    const event = yield* finalEvent({ type: "login" }, (event) => event.type === "open" ? openSignInPage(event.url) : Effect.void);
    if (event.type !== "signedIn") return yield* unexpected(event);
    return event.machine;
  }

  *logout(): Effect.fn.Return<boolean, DaemonError> {
    const event = yield* finalEvent({ type: "logout" });
    if (event.type !== "signedOut") return yield* unexpected(event);
    return event.revoked;
  }

  *listSyncedSkills(): Effect.fn.Return<ReadonlyArray<ListedSkill>, DaemonError> {
    const event = yield* finalEvent({ type: "list" });
    if (event.type !== "list") return yield* unexpected(event);
    return event.skills;
  }

  *addSkill(skill: string): Effect.fn.Return<AddedSkill, DaemonError> {
    const event = yield* finalEvent({ type: "add", skill });
    if (event.type !== "added") return yield* unexpected(event);
    return { added: event.added, folders: event.folders, syncingFolders: event.syncingFolders };
  }

  *startDaemon(): Effect.fn.Return<void> {
    const statuses = yield* pipe(daemonStatuses, Effect.catch(() => Effect.succeed([])));
    const ours = statuses.filter((status) => status.registration.packageName === name && status.executableExists);
    for (const { registration } of ours) {
      const command: string[] = registration.kind === "launchd"
        ? ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${registration.unit}`]
        : registration.kind === "systemd"
          ? ["systemctl", "--user", "restart", registration.unit]
          : ["schtasks", "/Run", "/TN", registration.unit];
      const result = yield* Effect.sync(() => spawnSync(command[0]!, command.slice(1), { stdio: ["ignore", "ignore", "pipe"] }));
      if (result.status !== 0) {
        yield* Effect.logError(`Could not start ${registration.unit}: ${String(result.stderr ?? "").trim() || `exit ${result.status}`}`);
      }
    }
  }
}

/** The event that ends the conversation, after handing each earlier one (only `open`, during login) to `onEvent`. */
function finalEvent(
  message: ControlRequest,
  onEvent: (event: ControlEvent) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<ControlEvent, DaemonError> {
  return pipe(
    requestEvents(message),
    Stream.tap(onEvent),
    Stream.runLast,
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new DaemonFailed({ message: "the daemon closed the connection without answering" })),
      onSome: (event) => Effect.succeed(event),
    })),
  );
}

/** An `error` event is the daemon refusing the request; anything else is an answer to a different request. */
function unexpected(event: ControlEvent): Effect.Effect<never, DaemonFailed> {
  return Effect.fail(new DaemonFailed({
    message: event.type === "error" ? event.message : `unexpected answer from the daemon: ${JSON.stringify(event)}`,
  }));
}

export const DaemonControlLive = Layer.succeed(DaemonControl, new DaemonControlImpl());
