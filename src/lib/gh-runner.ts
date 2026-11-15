import { execFile } from "node:child_process";

/**
 * Asynchronous `gh` CLI execution (#290).
 *
 * Every GitHub call in Studio shells out to `gh`. Doing that with
 * `execFileSync` blocked the event loop for the whole round trip, so all
 * gh calls go through this module instead: non-blocking, bounded by a
 * timeout, and capped so a cache sweep plus UI reads cannot pile up
 * processes. Calls are never retried here; a failed write may have
 * completed on GitHub.
 */

export const DEFAULT_GH_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface GhRunOptions {
  cwd?: string;
  stdin?: string;
  /** Execution deadline; time spent queued for a slot does not count. */
  timeoutMs?: number;
}

export class GhCommandError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "GhCommandError";
  }
}

function concurrencyLimit(): number {
  const parsed = Number.parseInt(process.env.STUDIO_GH_CONCURRENCY ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
}

let active = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (active < concurrencyLimit()) {
    active += 1;
    return;
  }
  // The releasing call hands its slot over directly, so `active` is unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next();
  } else {
    active -= 1;
  }
}

/** Current slot usage; exposed for tests and diagnostics. */
export function getGhConcurrency(): { active: number; queued: number } {
  return { active, queued: waiting.length };
}

/**
 * Run a CLI command under the shared gh slot limit and resolve with its
 * stdout. Never invokes a shell. Exported so tests can substitute a
 * stand-in binary; production code calls `runGh`.
 */
export async function runSlottedCommand(command: string, args: string[], options: GhRunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  await acquireSlot();
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(command, args, {
        cwd: options.cwd,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const timedOut = error.killed === true;
        const detail = String(stderr ?? "").trim() || error.message;
        reject(new GhCommandError(
          timedOut ? `${command} command timed out after ${timeoutMs}ms` : detail,
          timedOut,
          String(stderr ?? ""),
          typeof error.code === "number" ? error.code : null,
        ));
      });
      // A command that exits before reading stdin raises EPIPE; the exit
      // status reported through the callback above is the real outcome.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin ?? "");
    });
  } finally {
    releaseSlot();
  }
}

/** Run `gh` with the given arguments and resolve with its stdout. */
export function runGh(args: string[], options: GhRunOptions = {}): Promise<string> {
  return runSlottedCommand("gh", args, options);
}
