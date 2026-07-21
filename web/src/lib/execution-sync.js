export function createExecutionSyncCoordinator({ reload, now = () => new Date(), onStateChange = () => {} }) {
  let state = {
    status: "idle",
    lastSuccessfulSyncAt: null,
    error: null,
  };
  let disposed = false;
  let running = false;
  let queued = false;
  let drainPromise = null;

  function publish(nextState) {
    if (disposed) return;
    state = nextState;
    onStateChange(state);
  }

  async function drain() {
    do {
      queued = false;
      publish({ ...state, status: "syncing", error: null });

      try {
        await reload();
        if (disposed) return;
        publish({
          status: "fresh",
          lastSuccessfulSyncAt: now(),
          error: null,
        });
      } catch (error) {
        if (disposed) return;
        publish({
          status: "stale",
          lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
          error,
        });
      }
    } while (queued && !disposed);
  }

  function requestSync() {
    if (disposed) return Promise.resolve();
    if (running) {
      queued = true;
      return drainPromise;
    }

    running = true;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        running = false;
        drainPromise = null;
      });
    return drainPromise;
  }

  function dispose() {
    disposed = true;
    queued = false;
  }

  return {
    requestSync,
    dispose,
    getState: () => state,
  };
}
