# Phase 7 — Extract planner tools into a registry

**Status:** proposed
**Predecessors:** [phase-6-platform-module.md](phase-6-platform-module.md)
**Successors:** [phase-8-delete-dead-code.md](phase-8-delete-dead-code.md)
**Estimated effort:** 2 days
**Net forwardRef change:** **0** (4 → 4)

## Motivation

`PlanningService` at
[`src/modules/planning/planning.service.ts`](../../src/modules/planning/planning.service.ts)
is 1378 lines, and **440 of them are ten inline `defineTool({...})`
calls** for the root-planner custom tools — see
[`assessment.md`](assessment.md) §10. Each tool is a self-contained
factory with its own schema, prompt snippet, prompt guidelines, and
`execute` body. They don't share state with each other, they don't
share state with the rest of the class, and each one has distinct
collaborators (GraphService, GraphWriterService, MemoryService,
SubAgentService, GitHubService, ReconciliationService).

The god class isn't just a size problem. Each tool is an extension
point — adding a new planner tool means editing the same 1378-line
file that already contains session lifecycle, approval endpoints,
alias tracking, and event fan-out. Merge conflicts on that file are
inevitable for any repo with multiple contributors. Per-tool unit
tests are painful because the test has to construct the whole
`PlanningService` to reach one tool's `execute` body.

This phase moves each tool to its own file behind a registry, and
trims `PlanningService` down to session lifecycle + approvals +
stream management (~500 lines target).

## Scope

**In:**

- Create `src/modules/planning/tools/` directory.
- Create one file per tool (10 files):
  - `graph-query.tool.ts`
  - `propose-mutations.tool.ts`
  - `graph-mutate.tool.ts`
  - `memory-read.tool.ts`
  - `memory-write.tool.ts`
  - `delegate-subagent.tool.ts`
  - `github-read.tool.ts`
  - `github-create-issue.tool.ts`
  - `github-sync.tool.ts`
  - `reconciliation-query.tool.ts`
- Create `src/modules/planning/tools/tool-registry.ts` — exports a
  single `createPlanningTools(deps)` factory function that returns
  the array passed to `createAgentSession({ customTools })`.
- Create `src/modules/planning/tools/types.ts` with a `PlanningToolDeps`
  interface describing the dependency bag every tool factory receives.
- Extract the proposal-accumulation state (`proposals`,
  `memoryChanges`, `githubSyncs`, `activeProposalId`,
  `activeMemoryChangeId`, `activeGitHubSyncId`, `issueIdAliases`)
  into a new `ProposalStateService` — this is the shared mutable
  state that the tools need access to.
- Rewrite `PlanningService` to inject `ProposalStateService` and
  construct tools via `createPlanningTools(...)`.
- Move inline helper methods that belong with specific tools into
  the tool files:
  - `normalizeProposal`, `normalizeProposalMutation`,
    `updateActiveProposalAfterApply`, `accumulateMutations`,
    `rememberIssueIdAlias`, `resolveIssueIdAlias`,
    `getStagedWorkItemIds`, `rewriteProposalIssueAliases`,
    `rewriteProposalMutationIssueAliases` — all move to
    `ProposalStateService` or the `github-create-issue.tool.ts`.
  - `normalizeMemoryChange`, `normalizeMemoryEdit`,
    `updateActiveMemoryChangeAfterApply` → `ProposalStateService`.
  - `normalizeGitHubSync`, `updateActiveGitHubSyncAfterApply` →
    `ProposalStateService`.
  - `toGraphMutation` → `propose-mutations.tool.ts` (it's only used
    when applying a proposal's mutations).

**Out:**

- No changes to the root-planner session lifecycle, the SSE stream,
  or the approval endpoints' HTTP contract.
- No changes to tool schemas (the LLM's memory of tool names and
  parameters stays stable).
- No changes to the proposal/memory-change/github-sync approval
  flows. They still go through `POST /api/agent/proposals/approve`,
  `POST /api/agent/memory/approve`, `POST /api/agent/github/approve`.
- No changes to the event envelope shapes on `/api/agent/stream`.
- No new tools. Adding tools is the phase-after.
- No new forwardRefs.

## File changes

### 1. `src/modules/planning/tools/types.ts` (new)

```typescript
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { GraphService } from "../../graph/graph.service.js";
import type { GraphWriterService } from "../../graph/graph-writer.service.js";
import type { MemoryService } from "../memory.service.js";
import type { SubAgentService } from "../sub-agent.service.js";
import type { GitHubService } from "../../github/github.service.js";
import type { ReconciliationService } from "../../reconciliation/reconciliation.service.js";
import type { ProposalStateService } from "../proposal-state.service.js";

export interface PlanningToolDeps {
  graphService: GraphService;
  graphWriter: GraphWriterService;
  memoryService: MemoryService;
  subAgentService: SubAgentService;
  githubService: GitHubService;
  reconciliationService: ReconciliationService;
  proposalState: ProposalStateService;
  getCurrentTurnId: () => string | null;
  getSession: () => AgentSession | undefined;
  emitStudioEvent: (type: string, payload: unknown) => void;
  now: () => string;
}
```

### 2. `src/modules/planning/tools/graph-query.tool.ts` (example)

```typescript
import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { PlanningToolDeps } from "./types.js";
import type { GraphQueryToolInput } from "../types.js";

export function createGraphQueryTool(deps: PlanningToolDeps) {
  return defineTool({
    name: "graph_query",
    label: "Graph Query",
    description: "Query the Studio planning graph, frontier, or dispatch plan.",
    promptSnippet: "graph_query: inspect graph, frontier, or dispatch plan data before proposing structural changes.",
    promptGuidelines: [
      "Use graph_query to inspect the current graph/frontier/plan before proposing structural graph changes.",
    ],
    parameters: Type.Object({
      query: Type.Union([Type.Literal("graph"), Type.Literal("frontier"), Type.Literal("plan")]),
      repo: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
      track: Type.Optional(Type.String()),
      phase: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params: GraphQueryToolInput) => {
      const result = params.query === "graph"
        ? deps.graphService.getGraph({ repo: params.repo, state: params.state, track: params.track, phase: params.phase })
        : params.query === "frontier"
          ? deps.graphService.getFrontier(params.repo)
          : deps.graphService.getPlan(params.repo);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
```

Same shape for all 10 tools. Each is ~40–60 lines (the big ones,
`github_create_issue` and `propose_mutations`, are ~100–150).

### 3. `src/modules/planning/tools/tool-registry.ts`

```typescript
import type { PlanningToolDeps } from "./types.js";
import { createGraphQueryTool } from "./graph-query.tool.js";
import { createProposeMutationsTool } from "./propose-mutations.tool.js";
import { createGraphMutateTool } from "./graph-mutate.tool.js";
import { createMemoryReadTool } from "./memory-read.tool.js";
import { createMemoryWriteTool } from "./memory-write.tool.js";
import { createDelegateSubAgentTool } from "./delegate-subagent.tool.js";
import { createGitHubReadTool } from "./github-read.tool.js";
import { createGitHubCreateIssueTool } from "./github-create-issue.tool.js";
import { createGitHubSyncTool } from "./github-sync.tool.js";
import { createReconciliationQueryTool } from "./reconciliation-query.tool.js";

export function createPlanningTools(deps: PlanningToolDeps) {
  return [
    createGraphQueryTool(deps),
    createProposeMutationsTool(deps),
    createGraphMutateTool(deps),
    createMemoryReadTool(deps),
    createMemoryWriteTool(deps),
    createDelegateSubAgentTool(deps),
    createGitHubReadTool(deps),
    createGitHubCreateIssueTool(deps),
    createGitHubSyncTool(deps),
    createReconciliationQueryTool(deps),
  ];
}
```

### 4. `src/modules/planning/proposal-state.service.ts` (new)

```typescript
@Injectable()
export class ProposalStateService {
  private readonly proposals = new Map<string, PlanningMutationProposal>();
  private readonly memoryChanges = new Map<string, PlanningMemoryChange>();
  private readonly githubSyncs = new Map<string, GitHubSyncProposal>();
  private readonly issueIdAliases = new Map<string, string>();
  private activeProposalId: string | null = null;
  private activeMemoryChangeId: string | null = null;
  private activeGitHubSyncId: string | null = null;
  private proposalCounter = 0;

  constructor(
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(MemoryService) private readonly memory: MemoryService,
  ) {}

  // Proposals
  normalizeProposal(input: ProposeMutationsToolInput, source: ProposalSource): PlanningMutationProposal;
  setActiveProposal(proposal: PlanningMutationProposal): void;
  getActiveProposal(): PlanningMutationProposal | null;
  getActiveProposalForAccumulation(currentTurnId: string | null): PlanningMutationProposal | null;
  accumulateMutations(existing, newMutations, summaryAppendix): PlanningMutationProposal;
  updateActiveProposalAfterApply(proposal, approvedIds): PlanningMutationProposal | null;
  rewriteProposalIssueAliases(proposal): PlanningMutationProposal;
  rememberIssueIdAlias(requestedId, finalId, stagedWorkItemIds): void;
  resolveIssueIdAlias(id, stopIds): string;
  resetTurnState(): void;  // called at turn_start — clears issueIdAliases

  // Memory changes — same shape
  normalizeMemoryChange(input): PlanningMemoryChange;
  setActiveMemoryChange(change): void;
  getActiveMemoryChange(): PlanningMemoryChange | null;
  updateActiveMemoryChangeAfterApply(change, approvedEditIds): PlanningMemoryChange | null;

  // GitHub syncs — same shape
  normalizeGitHubSync(...): Promise<GitHubSyncProposal>;
  setActiveGitHubSync(sync): void;
  getActiveGitHubSync(): GitHubSyncProposal | null;
  updateActiveGitHubSyncAfterApply(proposal, approvedIds): GitHubSyncProposal | null;

  dismissAll(): { dismissed_proposal_ids, dismissed_memory_change_ids, dismissed_github_sync_ids };
}
```

### 5. `src/modules/planning/planning.service.ts` (rewrite)

Target: **~500 lines**, down from 1378.

Remaining responsibilities:
- Session lifecycle (`ensureSession`, `createOrResumeSession`,
  `onModuleInit`, `onModuleDestroy`)
- Stream management (`stream`, `handleSessionEvent`,
  `emitStudioEvent`, `isStreamableEvent`)
- The three approval endpoints (`approveProposal`, `approveMemoryChange`,
  `approveGitHubSync`) — thin wrappers that delegate to
  `ProposalStateService` for state updates and to `GraphWriterService` /
  `MemoryService` / `GitHubService` for the actual writes
- `sendMessage` + context assembly wire-up
- `getSessionSnapshot` — projects state from ProposalStateService
- `projectSessionEntries`, `messageContentToText`, `stripStudioContext`
- `dismissAllProposals` — delegates to ProposalStateService

Deleted (moved): every `createXxxTool()` method, the alias helpers,
the normalizer helpers, `toGraphMutation`, `accumulateMutations`.

### 6. `src/modules/planning/planning.module.ts`

```diff
  providers: [
    PlanningService,
+   ProposalStateService,
    ContextService,
    MemoryService,
    SubAgentService,
  ],
  exports: [
    PlanningService,
+   ProposalStateService,
    ContextService,
    MemoryService,
    SubAgentService,
  ],
```

No import changes. `PlanningModule` already pulls in everything the
tools need.

## Tests

**New:**
- `src/modules/planning/tools/__tests__/` — one test file per tool.
  Construct the tool with a stub `PlanningToolDeps`, call the
  tool's `execute` body, assert delegate calls and return shape.
- `src/modules/planning/__tests__/proposal-state.service.test.ts` —
  alias resolution, accumulation, staleness detection.

**Modified:**
- `planning.service.test.ts` shrinks significantly — most of its
  current coverage becomes per-tool tests. What stays: session
  lifecycle assertions, approval endpoint happy paths, snapshot
  projection.

## Acceptance criteria

- [ ] `src/modules/planning/tools/` contains 10 tool files +
      `tool-registry.ts` + `types.ts`
- [ ] `src/modules/planning/proposal-state.service.ts` exists,
      `@Injectable`, registered in module
- [ ] `PlanningService` line count under 600
- [ ] No `createXxxTool()` methods remain on `PlanningService`
- [ ] Existing planner tool behaviour unchanged — the root planner
      can still call each of the 10 tools with the same parameter
      shapes and get the same results (smoke via the README manual
      verification steps 8, 9, 14, 17, 18)
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` still sums
      to **4**
- [ ] `npm test` passes

## Known remaining drift

- `ProposalStateService` is still a single service holding three
  independent proposal types (mutations, memory, GitHub sync). A
  future refactor could split it into three, but the phase-7 scope
  is "extract the tools," not "decompose proposal state."
- `PlanningService.handleSessionEvent` still does turn-boundary
  bookkeeping (reset `issueIdAliases`). That's ProposalStateService
  state, so handleSessionEvent calls `proposalState.resetTurnState()`
  at `turn_start`. Slightly awkward but correct.
- The tool files each carry imports for `@sinclair/typebox` and
  `@mariozechner/pi-coding-agent`. That's a real increase in file
  count for the planning module; see §"ceremony cost" in
  [`assessment.md`](assessment.md) §12 Phase 7 discussion. The win
  is per-tool review surface, not total LOC.

## Next

[Phase 8](phase-8-delete-dead-code.md) does the cleanup sweep:
delete `GitModule` + its tests, delete legacy Svelte components,
rename `ReconciliationService` → `DriftReportService`, drop the
orphaned `createHsmRunRecord` method on `ExecutionService`.
