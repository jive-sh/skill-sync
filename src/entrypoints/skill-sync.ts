import { spawn, spawnSync } from "node:child_process";
import { Command } from "commander";
import { Effect } from "effect";
import { daemonStatuses, upgrade } from "jive-abstract-library";
import { name } from "../../package.json";
import { DaemonUnreachable, request, type ControlEvent, type ControlRequest } from "../internal/control";

/**
 * The CLI that accompanies the daemon: `login`, `logout`, `list` and `upgrade`, and nothing else — which
 * folders and skills sync is chosen on the dashboard.
 *
 * The daemon owns the sync token and keeps it only in memory. `login`, `logout` and `list` are requests to
 * it over the control socket; the token goes from the browser straight to the daemon and never through here.
 */

const program = new Command("skill-sync")
  .description("keep the skills you choose identical across every Claude and Codex skills folder on every machine; choose them at https://skill-sync.jive.sh/");

program
  .command("login")
  .description("sign this machine in with your passkey in the browser; the daemon keeps the token in memory")
  .action(async () => {
    const result = await withDaemon({ type: "login" }, (event) => {
      if (event.type !== "open") return;
      console.log(`Opening ${event.url}`);
      openBrowser(event.url);
    });
    if (result.type === "signedIn") {
      console.log(`Signed in. ${result.machine} is syncing; choose what syncs at https://skill-sync.jive.sh/`);
    } else {
      fail(result);
    }
  });

program
  .command("logout")
  .description("revoke this machine's token and stop syncing until the next login")
  .action(async () => {
    const result = await withDaemon({ type: "logout" }, () => undefined);
    if (result.type === "signedOut") {
      console.log(result.revoked ? "Signed out; the token is revoked." : "Signed out locally; the server could not be reached to revoke the token.");
    } else {
      fail(result);
    }
  });

program
  .command("list")
  .description("list the skills that sync, as the server holds them; needs this machine signed in")
  .action(async () => {
    const result = await withDaemon({ type: "list" }, () => undefined);
    if (result.type !== "list") fail(result);
    if (result.skills.length === 0) {
      console.log("No skills sync yet; tick them at https://skill-sync.jive.sh/");
      return;
    }
    const width = Math.max(...result.skills.map((skill) => skill.name.length));
    for (const skill of result.skills) {
      const detail = skill.editedAt === null
        ? "no files yet"
        : `${skill.files} ${skill.files === 1 ? "file" : "files"}, last edited ${new Date(skill.editedAt).toLocaleString()} on ${skill.editedBy}`;
      console.log(`${skill.name.padEnd(width)}  ${detail}`);
    }
  });

program
  .command("upgrade")
  .description("upgrade skill-sync to the latest version with the package manager that installed it")
  .action(async () => {
    await Effect.runPromise(upgrade({ packageName: name })).catch((cause: unknown) => {
      console.error(`Upgrade failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      process.exit(1);
    });
  });

program.parse();
if (process.argv.length <= 2) program.help();

/**
 * Sends a request to the running daemon. If none is listening — stopped, or never started since the
 * install — this package's registered daemon is started through its service manager and the request is
 * retried for a few seconds.
 */
async function withDaemon(message: ControlRequest, onEvent: (event: ControlEvent) => void): Promise<ControlEvent> {
  try {
    return await request(message, onEvent);
  } catch (cause) {
    if (!(cause instanceof DaemonUnreachable)) throw cause;
  }
  await startDaemons();
  for (let attempt = 0; ; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      return await request(message, onEvent);
    } catch (cause) {
      if (!(cause instanceof DaemonUnreachable) || attempt >= 20) {
        console.error(`${cause instanceof Error ? cause.message : String(cause)}. Reinstall skill-sync to register its daemon.`);
        process.exit(1);
      }
    }
  }
}

function fail(event: ControlEvent): never {
  console.error(event.type === "error" ? event.message : `unexpected answer from the daemon: ${JSON.stringify(event)}`);
  process.exit(1);
}

/** Starts this package's registered daemons through their service manager. */
async function startDaemons(): Promise<void> {
  const statuses = await Effect.runPromise(daemonStatuses).catch(() => []);
  const ours = statuses.filter((status) => status.registration.packageName === name && status.executableExists);
  if (ours.length === 0) {
    return;
  }
  for (const { registration } of ours) {
    const command: string[] = registration.kind === "launchd"
      ? ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${registration.unit}`]
      : registration.kind === "systemd"
        ? ["systemctl", "--user", "restart", registration.unit]
        : ["schtasks", "/Run", "/TN", registration.unit];
    const result = spawnSync(command[0]!, command.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    if (result.status !== 0) {
      console.error(`Could not start ${registration.unit}: ${String(result.stderr ?? "").trim() || `exit ${result.status}`}`);
    }
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}
