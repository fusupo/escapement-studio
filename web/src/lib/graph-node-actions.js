const DEFAULT_MENU_PADDING = 12;

export function buildGraphNodeContextMenu({
  item,
  launchEligibility,
  launchEligibilityLoading = false,
  launchingExecution = false,
} = {}) {
  if (!item) {
    return null;
  }

  const launchStatus = launchEligibilityLoading
    ? { label: "Checking…", tone: "loading" }
    : launchEligibility?.can_launch
      ? { label: "Dispatchable", tone: "ready" }
      : { label: "Blocked", tone: "blocked" };

  const launchDescription = launchEligibilityLoading
    ? "Checking launch eligibility…"
    : launchEligibility?.can_launch
      ? formatDispatchNodeSummary(launchEligibility.dispatch_node)
      : launchEligibility?.launch_unavailable_reason || "Launch execution is unavailable for this node.";

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

  actions.push({
    id: "launch-execution",
    kind: "button",
    label: launchingExecution ? "Launching…" : "Launch execution",
    description: launchDescription,
    disabled: launchEligibilityLoading || launchingExecution || !launchEligibility?.can_launch,
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
