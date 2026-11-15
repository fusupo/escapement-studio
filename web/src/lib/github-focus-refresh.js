import { refreshGitHubCache } from "./api.js";

export const FOCUS_REFRESH_INTERVAL_MS = 10_000;

/**
 * Rate-limited GitHub cache refresh (#291).
 *
 * Changes made on github.com reach Studio only through a cache sweep. The
 * app asks for one whenever its tab regains focus; several listeners react
 * to the same focus event, and browsers fire both `visibilitychange` and
 * `focus` for one tab switch, so the request is funnelled through here.
 *
 * `request()` starts a refresh unless one started less than `intervalMs`
 * ago. Callers that arrive while one is running share it. The promise
 * resolves to true when a refresh ran and succeeded, false when it was
 * skipped or failed, and never rejects: a failed refresh must not stop the
 * data sync that follows it. `force` ignores the interval (explicit
 * Refresh button) but still joins a refresh that is already running.
 */
export function createGitHubFocusRefresh({ refresh, now = () => Date.now(), intervalMs = FOCUS_REFRESH_INTERVAL_MS }) {
  let lastStartedAt = null;
  let inFlight = null;

  function request({ force = false } = {}) {
    if (inFlight) return inFlight;
    const startedAt = now();
    if (!force && lastStartedAt !== null && startedAt - lastStartedAt < intervalMs) {
      return Promise.resolve(false);
    }
    lastStartedAt = startedAt;
    inFlight = Promise.resolve()
      .then(() => refresh())
      .then(() => true, () => false)
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { request };
}

const appRefresh = createGitHubFocusRefresh({ refresh: () => refreshGitHubCache() });

/** App-wide instance: sweeps every tracked repo. */
export const requestGitHubRefresh = appRefresh.request;
