import type { Config } from "./config";
import { MACHINE_HEADER, MACHINE_MISMATCH_STATUS, type MachineMismatch, type SignInClaim, type SignInRequestCreated } from "./wire";

/**
 * Requests to the skill-sync service, signed with this machine's token.
 *
 * Every request goes through `fetchServer`, so a token the server no longer accepts, or one issued to another
 * machine, is noticed the same way whichever request hits it first.
 */

/** The server answered 401: the token was revoked or is unknown, so no retry with it can succeed. */
export class TokenRejected extends Error {
  constructor(message: string, readonly token: string) {
    super(message);
  }
}

/**
 * The server answered that the token belongs to `tokenMachine`, not to the machine this one is configured as:
 * most often a token file copied from another computer. No request with it can succeed, and the token is
 * still that other machine's, so it must not be revoked from here.
 */
export class TokenOfAnotherMachine extends Error {
  constructor(readonly configuredMachine: string, readonly tokenMachine: string, readonly token: string) {
    super(`this machine is configured as "${configuredMachine}" but its token belongs to "${tokenMachine}"`);
  }
}

export function authHeaders(config: Config, extra: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, [MACHINE_HEADER]: config.machine, ...extra };
}

/**
 * Sends one request to the server with the token. Throws `TokenRejected` on 401 and `TokenOfAnotherMachine` on
 * the service's machine mismatch; every other status is returned for the caller to judge, since some (a 409
 * from `PUT /files`) are answers rather than failures.
 */
export async function fetchServer(config: Config, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${config.endpoint}${path}`, {
    ...init,
    headers: authHeaders(config, (init.headers ?? {}) as Record<string, string>),
  });
  if (response.status === 401) {
    throw new TokenRejected(`${init.method ?? "GET"} ${path}: the server rejected this machine's token`, config.token);
  }
  if (response.status === MACHINE_MISMATCH_STATUS) {
    const body = await response.clone().json().catch(() => undefined) as Partial<MachineMismatch> | undefined;
    if (typeof body?.tokenMachine === "string") throw new TokenOfAnotherMachine(config.machine, body.tokenMachine, config.token);
  }
  return response;
}

/**
 * Opens a request to sign `machine` in. Sent without a token: the machine has none yet. See `SignInRequestCreated`
 * for what comes back and why the claim secret never leaves this process.
 */
export async function openSignInRequest(input: { readonly endpoint: string; readonly machine: string }): Promise<SignInRequestCreated> {
  const response = await fetch(`${input.endpoint}/cli/sign-in-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine: input.machine }),
  });
  if (!response.ok) throw new Error(`POST /cli/sign-in-requests: ${response.status} ${await response.text()}`);
  return await response.json() as SignInRequestCreated;
}

/** Asks whether the request was approved; the answer carries the token once it was. */
export async function claimSignInRequest(input: { readonly endpoint: string; readonly claimSecret: string }): Promise<SignInClaim> {
  const response = await fetch(`${input.endpoint}/cli/sign-in-requests/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimSecret: input.claimSecret }),
  });
  if (!response.ok) throw new Error(`POST /cli/sign-in-requests/claim: ${response.status} ${await response.text()}`);
  return await response.json() as SignInClaim;
}
