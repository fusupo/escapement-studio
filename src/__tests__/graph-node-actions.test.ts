import { describe, expect, it } from "vitest";
// @ts-expect-error -- test imports the browser-side helper directly.
import { buildGraphNodeContextMenu, clampContextMenuPosition } from "../../web/src/lib/graph-node-actions.js";

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "studio-139",
    name: "Add graph node context menu",
    kind: "issue",
    state: "ready",
    repo: "fusupo/escapement-studio",
    issue_number: 139,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/139",
    ...overrides,
  };
}

function makeEligibility(overrides: Record<string, unknown> = {}) {
  return {
    can_launch: true,
    launch_unavailable_reason: null,
    dispatch_node: {
      branch: "studio-139-branch",
      default_base_ref: "develop",
    },
    ...overrides,
  };
}

describe("buildGraphNodeContextMenu", () => {
  it("returns null when there is no selected item", () => {
    expect(buildGraphNodeContextMenu()).toBeNull();
  });

  it("builds issue and launch actions for dispatchable nodes", () => {
    const menu = buildGraphNodeContextMenu({
      item: makeItem(),
      launchEligibility: makeEligibility(),
    });

    expect(menu.title).toBe("studio-139");
    expect(menu.status).toEqual({ label: "Dispatchable", tone: "ready" });
    expect(menu.sections[0].actions).toEqual([
      {
        id: "open-issue",
        kind: "link",
        label: "Open issue #139",
        description: "fusupo/escapement-studio",
        href: "https://github.com/fusupo/escapement-studio/issues/139",
        external: true,
      },
      {
        id: "launch-execution",
        kind: "button",
        label: "Launch execution",
        description: "Branch studio-139-branch · Base develop",
        disabled: false,
        emphasis: "primary",
      },
    ]);
  });

  it("disables launch with a clear reason when the node is blocked", () => {
    const menu = buildGraphNodeContextMenu({
      item: makeItem({ issue_url: null, issue_number: null }),
      launchEligibility: makeEligibility({
        can_launch: false,
        launch_unavailable_reason: "Work item is not currently dispatchable from the frontier.",
      }),
    });

    expect(menu.status).toEqual({ label: "Blocked", tone: "blocked" });
    expect(menu.sections[0].actions).toHaveLength(1);
    expect(menu.sections[0].actions[0]).toMatchObject({
      id: "launch-execution",
      disabled: true,
      description: "Work item is not currently dispatchable from the frontier.",
    });
  });

  it("shows a loading state while launch eligibility is being fetched", () => {
    const menu = buildGraphNodeContextMenu({
      item: makeItem(),
      launchEligibilityLoading: true,
      launchEligibility: null,
    });

    expect(menu.status).toEqual({ label: "Checking…", tone: "loading" });
    const launchAction = menu.sections[0].actions.find((a: { id: string }) => a.id === "launch-execution");
    expect(launchAction).toMatchObject({
      id: "launch-execution",
      label: "Launch execution",
      disabled: true,
      description: "Checking launch eligibility…",
    });
  });

  describe("ADR 014 step 8 — plan actions", () => {
    function actionIds(menu: ReturnType<typeof buildGraphNodeContextMenu>): string[] {
      return menu?.sections[0].actions.map((a: { id: string }) => a.id) ?? [];
    }

    it("shows Prepare plan when work item is planned (no plan yet)", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "planned" }),
        launchEligibility: makeEligibility({ can_launch: false }),
        planState: null,
      });
      expect(actionIds(menu)).toContain("prepare-plan");
      expect(actionIds(menu)).not.toContain("approve-plan");
      expect(actionIds(menu)).not.toContain("review-plan");
    });

    it("shows Prepare + Approve + Review when plan is drafting", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "drafting" }),
        launchEligibility: makeEligibility({ can_launch: false }),
        planState: { state: "drafting" },
      });
      const ids = actionIds(menu);
      expect(ids).toContain("prepare-plan");
      expect(ids).toContain("approve-plan");
      expect(ids).toContain("review-plan");
    });

    it("shows only Review plan when plan is ready (Prepare is hidden)", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "ready" }),
        launchEligibility: makeEligibility(),
        planState: { state: "ready" },
      });
      const ids = actionIds(menu);
      expect(ids).not.toContain("prepare-plan");
      expect(ids).not.toContain("approve-plan");
      expect(ids).toContain("review-plan");
    });

    it("hides Prepare plan for non-issue kinds", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "planned", kind: "capability", issue_url: null, issue_number: null }),
        launchEligibility: makeEligibility({ can_launch: false }),
        planState: null,
      });
      expect(actionIds(menu)).not.toContain("prepare-plan");
    });

    it("disables launch when work item state is not ready, even if can_launch is true", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "planned" }),
        launchEligibility: makeEligibility(), // can_launch: true
        planState: null,
      });
      expect(menu.status).toEqual({ label: "Blocked", tone: "blocked" });
      const launchAction = menu?.sections[0].actions.find(
        (a: { id: string }) => a.id === "launch-execution",
      );
      expect(launchAction).toMatchObject({
        id: "launch-execution",
        disabled: true,
      });
      expect(launchAction?.description).toMatch(/Approve the plan first/);
    });

    it("enables launch only when state is ready AND can_launch is true", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "ready" }),
        launchEligibility: makeEligibility(),
        planState: { state: "ready" },
      });
      expect(menu.status).toEqual({ label: "Dispatchable", tone: "ready" });
      const launchAction = menu?.sections[0].actions.find(
        (a: { id: string }) => a.id === "launch-execution",
      );
      expect(launchAction).toMatchObject({
        id: "launch-execution",
        disabled: false,
      });
    });

    it("shows Preparing… label when preparingPlan is true", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "planned" }),
        launchEligibility: makeEligibility({ can_launch: false }),
        planState: null,
        preparingPlan: true,
      });
      const prepareAction = menu?.sections[0].actions.find(
        (a: { id: string }) => a.id === "prepare-plan",
      );
      expect(prepareAction).toMatchObject({ label: "Preparing…", disabled: true });
    });

    it("shows Approving… label when approvingPlan is true", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "drafting" }),
        launchEligibility: makeEligibility({ can_launch: false }),
        planState: { state: "drafting" },
        approvingPlan: true,
      });
      const approveAction = menu?.sections[0].actions.find(
        (a: { id: string }) => a.id === "approve-plan",
      );
      expect(approveAction).toMatchObject({ label: "Approving…", disabled: true });
    });

    it("does not show Prepare / Approve for terminal states", () => {
      const menu = buildGraphNodeContextMenu({
        item: makeItem({ state: "done" }),
        launchEligibility: makeEligibility({ can_launch: false }),
        planState: null,
      });
      const ids = actionIds(menu);
      expect(ids).not.toContain("prepare-plan");
      expect(ids).not.toContain("approve-plan");
      expect(ids).not.toContain("review-plan");
    });
  });
});

describe("clampContextMenuPosition", () => {
  it("leaves coordinates unchanged when they already fit", () => {
    expect(clampContextMenuPosition({
      x: 120,
      y: 80,
      menuWidth: 180,
      menuHeight: 140,
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 120, y: 80 });
  });

  it("clamps the menu inside the viewport padding", () => {
    expect(clampContextMenuPosition({
      x: 790,
      y: 590,
      menuWidth: 180,
      menuHeight: 140,
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 608, y: 448 });
  });

  it("pins very large menus to the viewport padding", () => {
    expect(clampContextMenuPosition({
      x: 4,
      y: 7,
      menuWidth: 1200,
      menuHeight: 900,
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 12, y: 12 });
  });
});
