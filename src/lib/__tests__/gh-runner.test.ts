import { describe, expect, it } from "vitest";
import { GhCommandError, getGhConcurrency, runSlottedCommand } from "../gh-runner.js";

const node = process.execPath;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("gh runner", () => {
  it("resolves with stdout and passes stdin through", async () => {
    const echo = "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => process.stdout.write('got:' + d));";
    await expect(runSlottedCommand(node, ["-e", echo], { stdin: "body text" })).resolves.toBe("got:body text");
  });

  it("keeps the event loop responsive while a slow command runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    let finished = false;
    const command = runSlottedCommand(node, ["-e", "setTimeout(() => console.log('done'), 300)"]).then((out) => { finished = true; return out; });
    await sleep(100);
    expect(finished).toBe(false);
    expect(ticks).toBeGreaterThanOrEqual(3);
    await expect(command).resolves.toContain("done");
    clearInterval(timer);
  });

  it("rejects with a timeout error instead of hanging", async () => {
    const error = await runSlottedCommand(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }).catch((e) => e);
    expect(error).toBeInstanceOf(GhCommandError);
    expect(error.timedOut).toBe(true);
    expect(error.message).toMatch(/timed out after 50ms/);
  });

  it("reports stderr and the exit code on failure", async () => {
    const error = await runSlottedCommand(node, ["-e", "console.error('HTTP 404: Not Found'); process.exit(3)"]).catch((e) => e);
    expect(error).toBeInstanceOf(GhCommandError);
    expect(error.timedOut).toBe(false);
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe("HTTP 404: Not Found");
  });

  it("tolerates a command that exits without reading stdin", async () => {
    await expect(runSlottedCommand(node, ["-e", "process.exit(0)"], { stdin: "x".repeat(200_000) })).resolves.toBe("");
  });

  it("caps concurrent commands and runs the queue in order", async () => {
    const slow = ["-e", "setTimeout(() => {}, 250)"];
    const all = Array.from({ length: 6 }, () => runSlottedCommand(node, slow));
    await sleep(50);
    expect(getGhConcurrency()).toEqual({ active: 4, queued: 2 });
    await Promise.all(all);
    expect(getGhConcurrency()).toEqual({ active: 0, queued: 0 });
  });

  it("releases its slot when a command fails", async () => {
    await runSlottedCommand(node, ["-e", "process.exit(1)"]).catch(() => {});
    expect(getGhConcurrency()).toEqual({ active: 0, queued: 0 });
  });
});
