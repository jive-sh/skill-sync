import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Finding and running an agent tool's own CLI.
 *
 * The daemon is started by the service manager (launchd, systemd, the Windows task scheduler), whose
 * PATH is the system's (`/usr/bin:/bin:/usr/sbin:/sbin` under launchd), not the user's shell's. So a CLI
 * is looked for on PATH and then in the folders its installers put it in.
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

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The first `name` on PATH, then in the install folders, then at the paths in `also` (an app bundle that
 * ships the CLI, an installer's own folder). Undefined when none exists.
 */
export function findCommand(input: { readonly name: string; readonly home: string; readonly also?: ReadonlyArray<string> }): string | undefined {
  const file = process.platform === "win32" ? `${input.name}.exe` : input.name;
  const onPath = (process.env.PATH ?? "").split(delimiter).filter((folder) => folder !== "");
  const candidates = [...[...onPath, ...installFolders(input.home)].map((folder) => join(folder, file)), ...(input.also ?? [])];
  return candidates.find(isFile);
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
