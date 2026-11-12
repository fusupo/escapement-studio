import { execFile } from "node:child_process";

/** Bounded, asynchronous process execution; never invokes a shell. */
export function runAsyncCommand(command: string, args: string[], options: {
  cwd: string;
  timeout?: number;
  onOutput?: (text: string) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: options.cwd, timeout: options.timeout ?? 120_000,
      killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
    }, (error) => error ? reject(error) : resolve());
    const report = (chunk: string | Buffer) => {
      const text = String(chunk).trim();
      if (text) options.onOutput?.(text.slice(-2000));
    };
    child.stdout?.on("data", report);
    child.stderr?.on("data", report);
  });
}
