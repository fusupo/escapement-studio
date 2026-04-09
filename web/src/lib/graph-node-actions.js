const DEFAULT_MENU_PADDING = 12;

// ADR 014 step 8 — plan action gating.
// Preparable states mirror PlansService.assertPreparable (planned | drafting).
const PREPARABLE_STATES = new Set(["planned", "drafting"]);

export function buildGraphNodeContextMenu({
  item,
  launchEligibility,
  launchEligibilityLoading = false,
  launchingExecution = false,
  planState = null,
  planStateLoading = false,
  preparingPlan = false,
  approvingPlan = false,
} = {}) {
  if (!item) {
    return null;
  }

  const workItemState = item.state ?? null;
  const planSubState = planState?.state ?? null;

  // UI gate is stricter than the backend: require work item state to be
  // `ready` before Launch is enabled, even though the server still accepts
  // `planned` as a transitional fallback. This nudges users toward the
  // approved-plan flow.
  const launchGateOk = !launchEligibilityLoading
    && !launchingExecution
    && launchEligibility?.can_launch === true
    && workItemState === "ready";

  const launchStatus = launchEligibilityLoading
    ? { label: "Checking…", tone: "loading" }
    : launchGateOk
      ? { label: "Dispatchable", tone: "ready" }
      : { label: "Blocked", tone: "blocked" };

  const launchDescription = launchEligibilityLoading
    ? "Checking launch eligibility…"
    : !launchEligibility?.can_launch
      ? launchEligibility?.launch_unavailable_reason || "Launch execution is unavailable for this node."
      : workItemState !== "ready"
        ? `Approve the plan first — work item state is ${workItemState ?? "unknown"}, expected ready.`
        : formatDispatchNodeSummary(launchEligibility.dispatch_node);

  const actions = [];

  if (item.issue_url) {
    actions.push({
      id: "open-issue",
      kind: "link",
      label: item.issue_number ? `Open issue #${item.issue_number}` : "Open issue",
      description: item.repo ? item.repo : "Open linked GitHub issue",
      href: item.issue_url,
      external: true,
    });
  }

  // Prepare plan — visible while the work item is still planned/drafting and
  // kind is `issue` (non-issue kinds don't get a scratchpad plan).
  if (item.kind === "issue" && PREPARABLE_STATES.has(workItemState)) {
    actions.push({
      id: "prepare-plan",
      kind: "button",
      label: preparingPlan ? "Preparing…" : "Prepare plan",
      description: planSubState === "drafting"
        ? "Re-run plan preparation to refresh the canonical scratchpad."
        : "Create a draft plan scratchpad for this work item.",
      disabled: preparingPlan || planStateLoading,
    });
  }

  // Approve plan — only meaningful while the plan is drafting.
  if (planSubState === "drafting") {
    actions.push({
      id: "approve-plan",
      kind: "button",
      label: approvingPlan ? "Approving…" : "Approve plan",
      description: "Transition the plan from drafting → ready and the work item to ready.",
      disabled: approvingPlan || planStateLoading,
    });
  }

  // Review plan — visible once a plan exists. Loading is informational only;
  // the button stays enabled because clicking it opens the modal which
  // handles its own fetch state.
  if (planSubState === "drafting" || planSubState === "ready") {
    actions.push({
      id: "review-plan",
      kind: "button",
      label: "Review plan",
      description: `Open the canonical scratchpad (plan is ${planSubState}).`,
      disabled: false,
    });
  }

  actions.push({
    id: "launch-execution",
    kind: "button",
    label: launchingExecution ? "Launching…" : "Launch execution",
    description: launchDescription,
    disabled: !launchGateOk,
    emphasis: "primary",
  });

  return {
    title: item.id,
    subtitle: item.name,
    status: launchStatus,
    sections: [
      {
        id: "node-actions",
        label: "Node actions",
        actions,
      },
    ],
  };
}

export function clampContextMenuPosition({
  x = 0,
  y = 0,
  menuWidth = 0,
  menuHeight = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  padding = DEFAULT_MENU_PADDING,
} = {}) {
  const maxX = Math.max(padding, viewportWidth - menuWidth - padding);
  const maxY = Math.max(padding, viewportHeight - menuHeight - padding);

  return {
    x: Math.max(padding, Math.min(x, maxX)),
    y: Math.max(padding, Math.min(y, maxY)),
  };
}

function formatDispatchNodeSummary(dispatchNode) {
  if (!dispatchNode) {
    return "Ready to launch using the standard execution flow.";
  }

  const parts = [];
  if (dispatchNode.branch) {
    parts.push(`Branch ${dispatchNode.branch}`);
  }
  if (dispatchNode.default_base_ref) {
    parts.push(`Base ${dispatchNode.default_base_ref}`);
  }

  return parts.length > 0
    ? parts.join(" · ")
    : "Ready to launch using the standard execution flow.";
}
