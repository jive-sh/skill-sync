import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, delimiter, join } from "node:path";
import { Schema } from "effect";
import { parseJson } from "./agent-tool";

/**
 * Finding and running an agent tool's own CLI.
 *
 * The daemon is started by the service manager (launchd, systemd, the Windows task scheduler), whose
 * PATH is the system's (`/usr/bin:/bin:/usr/sbin:/sbin` under launchd), not the user's shell's. So a CLI
 * is looked for on PATH, then in the folders its installers put it in, then on the PATH the user's own
 * login shell sets up, which covers any installer this list does not name. A CLI an app starts from its
 * own private folder is on none of those; it is found while it runs, and its path is remembered.
 */

/** Where package managers and installers put a user's commands, after PATH. */
function installFolders(home: string): string[] {
  return [
    join(home, ".local", "bin"), // Claude Code's native installer
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    ...nvmFolders(home),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
}

/** Every Node version nvm installed, newest name last; a global npm install lands in one of them. */
function nvmFolders(home: string): string[] {
  const versions = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(versions).sort().reverse().map((version) => join(versions, version, "bin"));
  } catch {
    return [];
  }
}

export const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The first `name` on PATH, then in the install folders, then at the paths in `also` (an app bundle that
 * ships the CLI, an installer's own folder), then on the login shell's PATH. Undefined when none exists.
 */
export function findCommand(input: { readonly name: string; readonly home: string; readonly also?: ReadonlyArray<string> }): string | undefined {
  const file = process.platform === "win32" ? `${input.name}.exe` : input.name;
  const onPath = (process.env.PATH ?? "").split(delimiter).filter((folder) => folder !== "");
  const candidates = [...[...onPath, ...installFolders(input.home)].map((folder) => join(folder, file)), ...(input.also ?? [])];
  return candidates.find(isFile)
    ?? loginShellFolders().map((folder) => join(folder, file)).find(isFile)
    ?? runningOrRemembered(input.name, input.home);
}

/** Where each CLI was last seen running: `~/.jive/skill-sync-commands.json`, `{ "codex": "/path/to/codex" }`. */
const rememberedPath = (home: string) => join(home, ".jive", "skill-sync-commands.json");

function readRemembered(home: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(rememberedPath(home), "utf-8"));
    return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch {
    return {};
  }
}

/**
 * A running process's executable named `name`, which is then remembered for when none runs; otherwise the
 * remembered one, if it still exists.
 */
function runningOrRemembered(name: string, home: string): string | undefined {
  const remembered = readRemembered(home);
  const running = runningExecutables(name).find(isFile);
  if (running !== undefined) {
    if (remembered[name] !== running) {
      try {
        writeFileSync(rememberedPath(home), JSON.stringify({ ...remembered, [name]: running }, null, 2) + "\n");
      } catch {
        // Not remembered: found again the next time it runs.
      }
    }
    return running;
  }
  const last = remembered[name];
  return last !== undefined && isFile(last) ? last : undefined;
}

/** The executables of running processes named `name`: from `ps` on macOS, `/proc/<pid>/exe` on Linux. */
export function runningExecutables(name: string): string[] {
  if (process.platform === "darwin") {
    const run = spawnSync("/bin/ps", ["-axo", "comm="], { encoding: "utf-8", timeout: 5_000 });
    return (run.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/") && basename(line) === name);
  }
  if (process.platform === "linux") {
    let pids: string[];
    try {
      pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
    } catch {
      return [];
    }
    return pids.flatMap((pid) => {
      try {
        const exe = readlinkSync(join("/proc", pid, "exe"));
        return basename(exe) === name ? [exe] : [];
      } catch {
        return [];
      }
    });
  }
  return [];
}

/** The login shell's PATH is read once per daemon process: starting the shell takes up to a second. */
let loginShellPathCache: ReadonlyArray<string> | undefined;

/**
 * The folders on the PATH the user's login shell sets up (its profile and rc files), as their terminal
 * sees it. Empty on Windows, whose service PATH is already the user's, and when the shell fails.
 */
export function loginShellFolders(): ReadonlyArray<string> {
  if (loginShellPathCache !== undefined) return loginShellPathCache;
  loginShellPathCache = process.platform === "win32" ? [] : readLoginShellPath();
  return loginShellPathCache;
}

function readLoginShellPath(): string[] {
  const shell = process.env.SHELL ?? userInfo().shell ?? "/bin/sh";
  // `env` prints PATH joined by ":" in every shell (fish keeps it as a list internally).
  const run = spawnSync(shell, ["-l", "-i", "-c", "env"], { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  const line = (run.stdout ?? "").split("\n").find((entry) => entry.startsWith("PATH="));
  return line === undefined ? [] : line.slice("PATH=".length).split(":").filter((folder) => folder !== "");
}

export interface CommandResult {
  /** Null when the command was killed or could not start. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it did not finish: it could not start, or ran past its timeout. */
  readonly failure: string | undefined;
}

/** Runs a command to completion without blocking the daemon, killing it after `timeoutMs`. */
export function runCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, [...input.args], { env: input.env, cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      failure = `did not finish within ${input.timeoutMs / 1000} s`;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    // A command that cannot start emits `error`, and may or may not emit `close` after it.
    const finish = (status: number | null) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, failure });
    };
    child.on("error", (error) => {
      failure = error.message;
      finish(null);
    });
    child.on("close", finish);
  });
}

/** One JSON-RPC response: `result` on success, `error` otherwise. */
export const RpcResponse = Schema.Struct({
  id: Schema.Finite,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
export type RpcResponse = Schema.Schema.Type<typeof RpcResponse>;

/** A message to send: a request when it has an `id`, a notification otherwise. */
export interface RpcMessage {
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Starts a CLI that speaks JSON-RPC over stdio (`codex app-server`, `grok agent stdio`), sends `messages`, and
 * stops it once every request has an answer. The first request is the handshake: an error answering it ends the
 * conversation, since the server answers nothing after a refused handshake. `name` says which CLI in a failure.
 */
export function askJsonRpc(input: {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly messages: ReadonlyArray<RpcMessage>;
}): Promise<
  | { readonly kind: "answered"; readonly answers: ReadonlyMap<number, RpcResponse> }
  | { readonly kind: "failed"; readonly reason: string }
> {
  const { name } = input;
  const requestIds = input.messages.flatMap((message) => message.id === undefined ? [] : [message.id]);
  const handshakeId = requestIds[0];
  return new Promise((resolve) => {
    const child = spawn(input.command, [...input.args], { env: input.env, cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const answers = new Map<number, RpcResponse>();
    let stderr = "";
    let pending = "";
    let settled = false;
    const settle = (outcome: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ kind: "failed", reason: `\`${name}\` did not answer within ${input.timeoutMs / 1000} s` }), input.timeoutMs);
    child.on("error", (error) => settle({ kind: "failed", reason: `\`${name}\` could not start: ${error.message}` }));
    child.on("close", (status) => settle({ kind: "failed", reason: `\`${name}\` exited (${status}) before answering: ${stderr.trim().slice(0, 160)}` }));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        // Notifications arrive between responses; only responses have an id.
        const response = Schema.decodeUnknownOption(RpcResponse)(parseJson(line));
        if (response._tag === "Some") answers.set(response.value.id, response.value);
      }
      const handshake = handshakeId === undefined ? undefined : answers.get(handshakeId);
      if (handshake?.error !== undefined) {
        settle({ kind: "failed", reason: `\`${name}\` refused to initialize: ${handshake.error.message.slice(0, 160)}` });
        return;
      }
      if (requestIds.every((id) => answers.has(id))) settle({ kind: "answered", answers });
    });
    // A dead stdin raises EPIPE here; the `close` above reports why the server went.
    child.stdin.on("error", () => {});
    child.stdin.write(input.messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  });
}
