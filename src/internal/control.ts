import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { CONTROL_SOCKET } from "./config";
import type { ListedSkill } from "./wire";

/**
 * The channel between the CLI and the running daemon.
 *
 * The daemon owns the sync token: it receives it from the browser and keeps it in `~/.jive/`, so it never
 * passes through the CLI. The CLI's `login`, `logout` and `list` are requests to the daemon over this
 * channel. Messages are newline-delimited JSON; each request gets events until one that
 * ends it.
 */

export type ControlRequest =
  | { readonly type: "login" }
  | { readonly type: "logout" }
  /** The synced list, which the daemon fetches from the server with its token. */
  | { readonly type: "list" };

export type ControlEvent =
  /** Sign-in has started: the CLI opens this URL in the browser, where the passkey is verified. */
  | { readonly type: "open"; readonly url: string }
  | { readonly type: "signedIn"; readonly machine: string }
  | { readonly type: "signedOut"; readonly revoked: boolean }
  | { readonly type: "list"; readonly skills: ReadonlyArray<ListedSkill> }
  | { readonly type: "error"; readonly message: string };

const isFinal = (event: ControlEvent): boolean => event.type !== "open";

/** The daemon is not running, as opposed to running and refusing the request. */
export class DaemonUnreachable extends Error {}

/** Sends one request and calls `onEvent` for each event until the final one, which it resolves with. */
export function request(message: ControlRequest, onEvent: (event: ControlEvent) => void): Promise<ControlEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = createConnection(CONTROL_SOCKET);
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("error", (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(cause.code === "ENOENT" || cause.code === "ECONNREFUSED"
        ? new DaemonUnreachable(`the skill-sync daemon is not running (${cause.code} on ${CONTROL_SOCKET})`)
        : cause);
    });
    readLines(socket, (line) => {
      const event = JSON.parse(line) as ControlEvent;
      onEvent(event);
      if (isFinal(event) && !settled) {
        settled = true;
        socket.end();
        resolve(event);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("the daemon closed the connection without answering"));
      }
    });
  });
}

/** One request being answered: send events, and end the conversation with a final one. */
export interface Reply {
  readonly send: (event: ControlEvent) => void;
}

/**
 * Listens on the control socket. Resolves false, without listening, when another live daemon already
 * holds it: two installs of skill-sync mean two daemons, and the second stands down rather than fight.
 */
export async function serve(handle: (message: ControlRequest, reply: Reply) => void): Promise<Server | false> {
  if (await answers()) return false;
  // Nothing answered, so a socket file left here is from a daemon that died; it would block the listen.
  if (process.platform !== "win32") rmSync(CONTROL_SOCKET, { force: true });

  const server = createServer((socket) => {
    const reply: Reply = {
      send: (event) => {
        if (socket.writable) socket.write(`${JSON.stringify(event)}\n`);
        if (isFinal(event)) socket.end();
      },
    };
    readLines(socket, (line) => {
      try {
        handle(JSON.parse(line) as ControlRequest, reply);
      } catch (cause) {
        reply.send({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    });
    socket.on("error", () => undefined); // A CLI that went away mid-request; nothing to tell it.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CONTROL_SOCKET, () => resolve());
  });
  // Only this user may talk to the daemon that holds their token.
  if (process.platform !== "win32") chmodSync(CONTROL_SOCKET, 0o600);
  return server;
}

/** Whether a live daemon is listening on the control socket. */
function answers(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(CONTROL_SOCKET);
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function readLines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") onLine(line);
    }
  });
}
