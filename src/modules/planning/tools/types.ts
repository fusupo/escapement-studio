import type { GitHubService } from "../../github/github.service.js";
import type { GraphService } from "../../graph/graph.service.js";
import type { MemoryService } from "../memory.service.js";
import type { ProposalStateService } from "../proposal-state.service.js";
import type { DriftReportService } from "../../drift-report/drift-report.service.js";
import type { SubAgentService } from "../sub-agent.service.js";

/**
 * Phase 7 (#227): the static dependency surface every planner tool
 * file is allowed to touch. Adding a new dep means updating this
 * interface AND `PlanningService.buildToolDeps()`.
 *
 * Tools should NOT inject services directly via Nest — the registry
 * pattern keeps them as pure factories so they're trivially
 * unit-testable with a stubbed `PlanningToolDeps` bag.
 */
export interface PlanningToolDeps {
  // Collaborator services
  graphService: GraphService;
  memoryService: MemoryService;
  subAgentService: SubAgentService;
  githubService: GitHubService;
  driftReportService: DriftReportService;
  proposalState: ProposalStateService;

  // PlanningService-owned hooks (callbacks so the SSE stream + counter
  // stay private to PlanningService).
  emitStudioEvent: (eventType: string, payload: unknown) => void;
  buildProposalDefaults: () => { currentTurnId: string | null; sessionId: string };
  getCurrentTurnId: () => string | null;
}
