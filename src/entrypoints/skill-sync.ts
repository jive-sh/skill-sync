import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { Effect } from "effect";
import { upgrade } from "jive-abstract-library";
import { name } from "../../package.json";
import { CONFIG_PATH, TOKEN_PATH, loadConfig, loadSettings } from "../internal/config";

/**
 * The CLI that accompanies the daemon.
 *
 * The daemon never authenticates anyone — it reads a token the CLI left behind and nothing more. Signing
 * in needs a browser and a person, which a process started at login has neither of, and a daemon that
 * could prompt for credentials would be a daemon that prompts you at every login.
 */

const program = new Command("skill-sync")
  .description("keep the skills you choose identical across every Claude folder on every machine; choose them at https://skill-sync.jive.sh/");

program
  .command("login")
  .description("verify with your passkey in the browser and store this machine's sync token")
  .action(async () => {
    // A missing token is exactly what we are here to fix, so only the settings have to be usable.
    const settings = loadSettings();
    if (settings === undefined) {
      console.error(`Fill in ${CONFIG_PATH} with an endpoint and a machine name first.`);
      process.exit(1);
    }

    const token = await captureToken(settings.endpoint, settings.machine);
    writeFileSync(TOKEN_PATH, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
    console.log(`Signed in. Token saved to ${TOKEN_PATH}`);
    console.log(`Choose which folders sync at ${settings.endpoint}/`);
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
