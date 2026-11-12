import { describe, expect, it, vi } from "vitest";
import { runAsyncCommand } from "../async-command.js";

describe("asynchronous commands", () => {
  it("keeps timers responsive and streams output while the process runs", async () => {
    const output = vi.fn();
    let finished = false;
    const command = runAsyncCommand(process.execPath, ["-e", "console.log('started'); setTimeout(() => console.log('done'), 200)"], { cwd: process.cwd(), onOutput: output }).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    await command;
    expect(output).toHaveBeenCalledWith("started");
    expect(output).toHaveBeenCalledWith("done");
  });
  it("terminates a command that exceeds its deadline", async () => {
    await expect(runAsyncCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeout: 30 })).rejects.toMatchObject({ killed: true });
  });
});
