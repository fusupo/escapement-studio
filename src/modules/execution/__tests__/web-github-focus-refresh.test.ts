import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import * as focusRefresh from "../../../../web/src/lib/github-focus-refresh.js";

const { createGitHubFocusRefresh } = focusRefresh;

function setup(refresh = vi.fn().mockResolvedValue({ refreshed: [] })) {
  let time = 1_000_000;
  const helper = createGitHubFocusRefresh({ refresh, now: () => time, intervalMs: 10_000 });
  return { helper, refresh, advance: (ms: number) => { time += ms; } };
}

describe("GitHub focus refresh", () => {
  it("refreshes on the first request and reports that it ran", async () => {
    const { helper, refresh } = setup();
    await expect(helper.request()).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("skips requests inside the interval and refreshes again after it", async () => {
    const { helper, refresh, advance } = setup();
    await helper.request();
    advance(9_999);
    await expect(helper.request()).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(1);
    await expect(helper.request()).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("shares a refresh that is still running", async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { helper } = setup(refresh);
    const first = helper.request();
    const second = helper.request();
    const forced = helper.request({ force: true });
    await Promise.resolve();
    finish();
    await expect(Promise.all([first, second, forced])).resolves.toEqual([true, true, true]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("resolves false on failure without rejecting, and retries after the interval", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("gh command timed out")).mockResolvedValue(undefined);
    const { helper, advance } = setup(refresh);
    await expect(helper.request()).resolves.toBe(false);
    await expect(helper.request()).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(10_000);
    await expect(helper.request()).resolves.toBe(true);
  });

  it("force ignores the interval and restarts it", async () => {
    const { helper, refresh, advance } = setup();
    await helper.request();
    advance(2_000);
    await expect(helper.request({ force: true })).resolves.toBe(true);
    advance(9_000);
    await expect(helper.request()).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("treats a synchronous throw as a failed refresh", async () => {
    const { helper } = setup(vi.fn(() => { throw new Error("offline"); }));
    await expect(helper.request()).resolves.toBe(false);
  });
});
