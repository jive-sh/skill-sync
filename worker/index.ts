/**
 * The skill-sync service: a file index in D1, file contents in R2.
 *
 * Plain TypeScript rather than Effect, unlike the rest of this monorepo. The whole service is request
 * routing over four endpoints, and the conventions exist to keep large service graphs legible — there is
 * no graph here. If this grows a second concern, convert it.
 *
 * Content is addressed by hash, so a file that two machines happen to share is stored once, and a pull
 * that already has the bytes can skip fetching them.
 */

import { invalidPathReason } from "../src/internal/path";

export interface Env {
  readonly DB: D1Database;
  readonly CONTENT: R2Bucket;
  /**
   * Only set in `.dev.vars`, never in a deployment. Cloudflare Access does not sit in front of
   * `wrangler dev`, so without an escape hatch the whole service would be untestable locally — and
   * weakening the real auth path to make tests pass is how the real auth path stops being real.
   */
  readonly DEV_TOKEN?: string;
}

/** Cloudflare Access sets this on every request it lets through; it cannot be forged by the client. */
const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

interface FileRow {
  readonly path: string;
  readonly hash: string | null;
  readonly seq: number;
  readonly updated_at: number;
  readonly updated_by: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Reached through a browser that Cloudflare Access has already authenticated, so it authenticates
      // itself and must be handled before the bearer check below.
      if (request.method === "GET" && path === "/cli/login") return await cliLogin(request, url, env);

      if (!(await authorized(request, env))) return json({ error: "unauthorized" }, 401);

      if (request.method === "GET" && path === "/files") return await listFiles(url, env);
      if (request.method === "GET" && path.startsWith("/content/")) return await getContent(path, env);
      if (request.method === "PUT" && path === "/files") return await putFile(request, env);
      if (request.method === "DELETE" && path === "/cli/token") return await revokeToken(request, env);
      return json({ error: "not found" }, 404);
    } catch (cause) {
      return json({ error: cause instanceof Error ? cause.message : String(cause) }, 500);
    }
  },
};

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // A fresh ArrayBuffer, because the Workers and Bun type definitions disagree on BufferSource.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!presented) return false;
  if (env.DEV_TOKEN && presented === env.DEV_TOKEN) return true;

  const row = await env.DB
    .prepare("SELECT token_hash FROM device_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(presented))
    .first<{ token_hash: string }>();
  if (row === null) return false;

  await env.DB.prepare("UPDATE device_tokens SET last_seen = ? WHERE token_hash = ?")
    .bind(Date.now(), row.token_hash).run();
  return true;
}

/**
 * Hands a freshly signed-in browser a token and bounces it back to the waiting CLI.
 *
 * The token goes to `127.0.0.1` and nowhere else: the CLI picks its own port, passes it here, and the
 * redirect can only reach a listener on this machine. A `redirect_url` taken from the request would let
 * any page that can make you visit it collect a token in your name, so only the port is accepted.
 */
async function cliLogin(request: Request, url: URL, env: Env): Promise<Response> {
  const email = request.headers.get(ACCESS_EMAIL_HEADER);
  if (!email) {
    return json({ error: "this endpoint must be behind Cloudflare Access" }, 403);
  }

  const port = Number(url.searchParams.get("port"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return json({ error: "port must be an integer between 1024 and 65535" }, 400);
  }
  const machine = url.searchParams.get("machine") ?? "unknown";

  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

  await env.DB
    .prepare("INSERT INTO device_tokens (token_hash, email, machine, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), email, machine, Date.now())
    .run();

  return Response.redirect(`http://127.0.0.1:${port}/?token=${token}`, 302);
}

/** Everything that changed after the caller's cursor, oldest first, so a partial apply can resume. */
async function listFiles(url: URL, env: Env): Promise<Response> {
  const since = Number(url.searchParams.get("since") ?? 0);
  const { results } = await env.DB
    .prepare("SELECT path, hash, seq, updated_at, updated_by FROM files WHERE seq > ? ORDER BY seq ASC LIMIT 500")
    .bind(Number.isFinite(since) ? since : 0)
    .all<FileRow>();

  const files = results ?? [];
  return json({
    cursor: files.length > 0 ? files[files.length - 1]!.seq : since,
    files: files.map((row) => ({
      path: row.path,
      hash: row.hash,
      deleted: row.hash === null,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    })),
  });
}

async function getContent(path: string, env: Env): Promise<Response> {
  const hash = path.slice("/content/".length);
  const object = await env.CONTENT.get(hash);
  if (object === null) return json({ error: `no content for ${hash}` }, 404);
  return new Response(object.body, { headers: { "content-type": "application/octet-stream" } });
}

/**
 * Compare-and-swap on the file's current hash.
 *
 * `baseHash` is what the client believed the server held when it started. If that no longer matches, some
 * other machine wrote in between and this request is refused with the hash that actually won — the client
 * decides what to do, and nothing is lost by a race. A client that has never seen the file sends null.
 */
async function putFile(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    path?: unknown; baseHash?: unknown; hash?: unknown; content?: unknown; machine?: unknown;
  };

  const path = typeof body.path === "string" ? body.path : undefined;
  const machine = typeof body.machine === "string" ? body.machine : undefined;
  if (!path || !machine) return json({ error: "path and machine are required" }, 400);

  const badPath = invalidPathReason(path);
  if (badPath) return json({ error: `rejected path: ${badPath}` }, 400);

  const hash = typeof body.hash === "string" ? body.hash : null;
  const baseHash = typeof body.baseHash === "string" ? body.baseHash : null;
  // Content is absent for a delete, and base64 so the transport does not care what is in the file.
  const content = typeof body.content === "string" ? body.content : null;
  if (hash !== null && content === null) return json({ error: "content is required unless deleting" }, 400);

  const existing = await env.DB
    .prepare("SELECT hash FROM files WHERE path = ?")
    .bind(path)
    .first<{ hash: string | null }>();

  if ((existing?.hash ?? null) !== baseHash) {
    return json({ error: "conflict", currentHash: existing?.hash ?? null }, 409);
  }
  if (hash !== null && hash === baseHash) return json({ ok: true, unchanged: true });

  if (hash !== null && content !== null) {
    const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    // Content is addressed by hash, so storing it under a hash it does not have would hand every other
    // machine the wrong bytes under a name they trust. Cheap to check, and only the server can.
    if (await sha256Bytes(bytes) !== hash) {
      return json({ error: "content does not match the hash it was sent under" }, 400);
    }
    await env.CONTENT.put(hash, bytes);
  }

  // The counter lives in the table rather than a separate row so a write is one statement and cannot
  // interleave with another writer's read of the previous maximum.
  await env.DB
    .prepare(`INSERT INTO files (path, hash, seq, updated_at, updated_by)
              VALUES (?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM files), ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                hash = excluded.hash,
                seq = (SELECT IFNULL(MAX(seq), 0) + 1 FROM files),
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by`)
    .bind(path, hash, Date.now(), machine)
    .run();

  return json({ ok: true });
}

/**
 * Revokes the token the caller presented.
 *
 * Deleting the local file is not revocation: a token copied off a machine before it was decommissioned
 * keeps working forever otherwise, and nothing in the service would ever notice.
 */
async function revokeToken(request: Request, env: Env): Promise<Response> {
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  await env.DB.prepare("DELETE FROM device_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(presented)).run();
  return json({ ok: true });
}
