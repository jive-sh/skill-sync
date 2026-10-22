import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { CONFIG_PATH, TOKEN_PATH, loadConfig, loadSettings, loadState, saveState } from "../internal/config";
import { syncOnce } from "../internal/sync";

/**
 * The CLI that accompanies the daemon.
 *
 * The daemon never authenticates anyone — it reads a token the CLI left behind and nothing more. Signing
 * in needs a browser and a person, which a process started at login has neither of, and a daemon that
 * could prompt for credentials would be a daemon that prompts you at every login.
 */

const program = new Command("skill-sync")
  .description("keep one skills directory identical across every machine you work on");

program
  .command("login")
  .description("verify with your passkey in the browser and store this machine's sync token")
  .action(async () => {
    // A missing token is exactly what we are here to fix, so only the settings have to be usable.
    const settings = loadSettings();
    if (settings === undefined) {
      console.error(`Fill in ${CONFIG_PATH} with an endpoint, a machine name and a skillsDir first.`);
      process.exit(1);
    }

    const token = await captureToken(settings.endpoint, settings.machine);
    writeFileSync(TOKEN_PATH, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
    console.log(`Signed in. Token saved to ${TOKEN_PATH}`);
  });

program
  .command("logout")
  .description("forget this machine's sync token")
  .action(async () => {
    const loaded = loadConfig();
    if (loaded.ok) {
      // Revoke first: if this fails, the token is still on disk and you can try again. Deleting it first
      // would leave a live token on the server that nobody can revoke any more.
      const response = await fetch(`${loaded.config.endpoint}/cli/token`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${loaded.config.token}` },
      });
      console.log(response.ok ? "Revoked on the server." : `Server revoke failed (${response.status}).`);
    }
    rmSync(TOKEN_PATH, { force: true });
    console.log(`Removed ${TOKEN_PATH}`);
  });

program
  .command("status")
  .description("show what this machine is configured to sync, and whether it can")
  .action(async () => {
    const loaded = loadConfig();
    if (!loaded.ok) {
      console.log(`Not ready: ${loaded.reason}`);
      return;
    }
    const { endpoint, skillsDir, machine } = loaded.config;
    console.log(`machine     ${machine}`);
    console.log(`skills      ${skillsDir}${existsSync(skillsDir) ? "" : "  (does not exist)"}`);
    console.log(`endpoint    ${endpoint}`);
    console.log(`settings    ${CONFIG_PATH}`);
    console.log(`cursor      ${loadState().cursor}`);

    const response = await fetch(`${endpoint}/files?since=0`, {
      headers: { authorization: `Bearer ${loaded.config.token}` },
    });
    console.log(response.ok
      ? `server      reachable, ${((await response.json()) as { files: unknown[] }).files.length} file(s)`
      : `server      ${response.status} ${response.statusText} — try \`skill-sync login\``);
  });

program
  .command("sync")
  .description("run one sync cycle now instead of waiting for the daemon")
  .action(async () => {
    const loaded = loadConfig();
    if (!loaded.ok) {
      console.error(`Not ready: ${loaded.reason}`);
      process.exit(1);
    }
    const state = loadState();
    const report = await syncOnce(loaded.config, state);
    saveState(state);
    for (const path of report.pulled) console.log(`pulled  ${path}`);
    for (const path of report.pushed) console.log(`pushed  ${path}`);
    for (const path of report.deletedLocally) console.log(`deleted ${path}`);
    for (const path of report.conflicts) console.log(`CONFLICT ${path} — your copy is at ${path}.local`);
    for (const path of report.rejected) console.log(`REJECTED ${path}`);
    if (Object.values(report).every((list) => list.length === 0)) console.log("already in sync");
  });

program.parse();
if (process.argv.length <= 2) program.help();

/**
 * Opens the browser at the service's login endpoint and waits for it to come back with a token.
 *
 * The browser does the authenticating, with a passkey for the service's domain; this only has to be
 * listening when it finishes. The listener is bound to 127.0.0.1 so nothing off this machine can receive
 * the redirect, and the port is whatever the OS hands out so two machines — or two attempts — never
 * contend for one.
 */
async function captureToken(endpoint: string, machine: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const token = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
      response.writeHead(200, { "content-type": "text/html" });
      response.end(token
        ? "<p>Signed in. You can close this tab.</p>"
        : "<p>No token in the redirect. Check the service logs.</p>");
      server.close();
      token ? resolve(token) : reject(new Error("the redirect carried no token"));
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const url = `${endpoint}/cli/login?port=${port}&machine=${encodeURIComponent(machine)}`;
      console.log(`Opening ${url}`);
      openBrowser(url);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the browser"));
    }, 180_000).unref();
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}
