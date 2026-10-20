/**
 * Validation for the one piece of untrusted input that becomes a filesystem path.
 *
 * Shared by the Worker and the daemon on purpose, and deliberately free of any Node import so the Worker
 * can bundle it. Both ends check: the server so one compromised client cannot poison what every machine
 * pulls, and the daemon because a server it does not control is not a thing to take paths from either.
 *
 * Without this, a pushed path of `../../.ssh/authorized_keys` is joined to the skills directory and
 * written wherever the daemon's user can write.
 */

/** Long enough for any real nesting, short enough that nothing can be used to exhaust anything. */
const MAX_LENGTH = 512;

export function invalidPathReason(path: string): string | undefined {
  if (path.length === 0 || path.length > MAX_LENGTH) return "path is empty or too long";
  if (path.includes("\0")) return "path contains a null byte";
  if (path.includes("\\")) return "path must use forward slashes";
  if (path.startsWith("/")) return "path must be relative";
  // A Windows drive letter is absolute on the machine that matters even though it has no leading slash.
  if (/^[A-Za-z]:/.test(path)) return "path must be relative";

  for (const segment of path.split("/")) {
    if (segment === "") return "path has an empty segment";
    if (segment === "." || segment === "..") return "path must not contain . or .. segments";
  }
  return undefined;
}

export function isValidPath(path: string): boolean {
  return invalidPathReason(path) === undefined;
}
