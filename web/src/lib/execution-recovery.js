function errorMessage(value) {
  if (!value) return "";
  return typeof value === "string" ? value : value.message || String(value);
}

function isReadyState(state) {
  return state === "ready" || state?.endsWith(".ready") === true;
}

/**
 * Projects the independently loaded recovery inputs into a stable view model.
 * The caller remains responsible for refreshing these inputs before acting.
 */
export function projectExecutionRecovery({
  run,
  workItem = null,
  eligibility = null,
  reconciled = null,
  loading = false,
  lookupError = null,
  actionInFlight = false,
  actionError = null,
} = {}) {
  if (run?.status !== "error") {
    return {
      active: false,
      graphState: null,
      canRedispatch: false,
      canInvestigate: false,
      shouldCleanupWorktree: false,
      reason: "",
      safetyChecks: [],
      loading: false,
      actionInFlight: false,
      error: "",
    };
  }

  const graphState = workItem?.state || "unknown";
  const lookupErrorMessage = errorMessage(lookupError);
  const actionErrorMessage = errorMessage(actionError);
  const canInvestigate = !isReadyState(workItem?.state)
    && reconciled?.enabled_events?.includes("user.investigate") === true;
  const canLaunchDirectly = isReadyState(workItem?.state)
    && eligibility?.issue_backed === true
    && eligibility?.can_launch === true;
  const staleWorktree = reconciled?.worktree?.exists === true;
  const staleWorktreeIsClean = staleWorktree
    && reconciled.worktree.dirty === false
    && reconciled.worktree.commits_ahead === 0;
  const unsafeStaleWorktree = staleWorktree && !staleWorktreeIsClean;
  const unavailable = loading || !!lookupErrorMessage || actionInFlight;
  const canRedispatch = !unavailable
    && !unsafeStaleWorktree
    && (canLaunchDirectly || canInvestigate);
  const reason = actionErrorMessage
    || lookupErrorMessage
    || (unsafeStaleWorktree
      ? "The failed run's worktree contains commits, changes, or unknown state. Studio preserved it instead of deleting work; inspect it before retrying."
      : "")
    || eligibility?.launch_unavailable_reason
    || reconciled?.rationale
    || (loading
      ? "Loading current work-item state and launch eligibility."
      : canLaunchDirectly
        ? "This work item is ready and eligible for a replacement run."
        : canInvestigate
          ? "Re-dispatch will investigate this errored run, refresh eligibility, and launch if allowed."
          : `Work item state ${graphState} is not currently eligible for re-dispatch.`);

  return {
    active: true,
    graphState,
    canRedispatch,
    canInvestigate,
    shouldCleanupWorktree: staleWorktreeIsClean,
    reason,
    safetyChecks: eligibility?.safety_checks || [],
    loading,
    actionInFlight,
    error: actionErrorMessage || lookupErrorMessage,
  };
}
