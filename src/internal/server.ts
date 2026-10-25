import type { Config } from "./config";

/**
 * Requests to the skill-sync service, signed with this machine's token.
 *
 * Every request goes through `fetchServer`, so a token the server no longer accepts is noticed the same
 * way whichever request hits it first.
 */

/** The server answered 401: the token was revoked or is unknown, so no retry with it can succeed. */
export class TokenRejected extends Error {
  constructor(message: string, readonly token: string) {
    super(message);
  }
}

export function authHeaders(config: Config, extra: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, "x-skill-sync-machine": config.machine, ...extra };
}

/**
 * Sends one request to the server with the token. Throws `TokenRejected` on 401; every other status is
 * returned for the caller to judge, since some (a 409 from `PUT /files`) are answers rather than failures.
 */
export async function fetchServer(config: Config, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${config.endpoint}${path}`, {
    ...init,
    headers: authHeaders(config, (init.headers ?? {}) as Record<string, string>),
  });
  if (response.status === 401) {
    throw new TokenRejected(`${init.method ?? "GET"} ${path}: the server rejected this machine's token`, config.token);
  }
  return response;
}
