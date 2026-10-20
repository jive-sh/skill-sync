import { spawn } from "node:child_process";

/**
 * A desktop notification, best effort.
 *
 * Best effort is the whole contract: a daemon that cannot tell you about a conflict is worse than one
 * that cannot sync, but a daemon that *dies* because a notification helper is missing is worse than
 * both. Every failure here is swallowed.
 *
 * This works because these daemons are registered per-user and run inside the logged-in session — a
 * LaunchAgent, a `systemctl --user` unit, a scheduled task. A system-wide service would have no desktop
 * to post to.
 */

/** No shell anywhere below: the arguments carry file paths, and a path is not a safe thing to interpolate. */
function run(command: string, args: ReadonlyArray<string>): void {
  try {
    spawn(command, [...args], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Swallowed on purpose; see above.
  }
}

export function notify(title: string, body: string): void {
  switch (process.platform) {
    case "darwin":
      // AppleScript string literals take double quotes and backslashes as escapes, and nothing else.
      return run("osascript", [
        "-e",
        `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`,
      ]);
    case "linux":
      return run("notify-send", [title, body]);
    case "win32":
      return run("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "[reflection.assembly]::LoadWithPartialName('System.Windows.Forms') > $null;"
        + "$n = New-Object System.Windows.Forms.NotifyIcon;"
        + "$n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true;"
        + `$n.ShowBalloonTip(10000, '${escapeSingleQuotes(title)}', '${escapeSingleQuotes(body)}', 'Warning')`,
      ]);
    default:
      return;
  }
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}
