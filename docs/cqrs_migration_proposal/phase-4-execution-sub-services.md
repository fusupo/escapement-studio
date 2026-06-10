# Phase 4 — Carve the remaining sub-services out of `ExecutionService`

**Status:** proposed
**Predecessors:** [phase-3-run-disposition-service.md](phase-3-run-disposition-service.md)
**Successors:** [phase-5-event-driven-cross-context.md](phase-5-event-driven-cross-context.md)
**Estimated effort:** 4–5 days (largest phase)
**Net forwardRef change:** **0** (8 → 8)

## Motivation

After Phase 3, `ExecutionService` is ~2500 lines. The remaining
responsibilities cluster cleanly, per [`assessment.md`](assessment.md)
§3:

| Cluster | Approx. lines | Current location |
|---|---:|---|
| Run store (buffer + disk + persistence primitives) | ~400 | 1984–2186 + scattered |
| Worktree management (git shell, safety checks) | ~200 | 1530–1609 + 706–790 + shell wrappers |
| Scratchpad (canonical sync, checklist, commit guards) | ~350 | 1747–1920 + 2270–2368 |
| Run interaction (agent session, disambiguation gate, follow-ups) | ~300 | 1183–1427 + 792–824 |
| Pull request (createPullRequest, syncMergedPullRequest, PR builders) | ~400 | 472–704 + 2261–2292 |
| Launch eligibility (getPreview, eligibility, safety checks) | ~250 | 302–392 + 1446–1528 |
| Orchestrator (launch + executeRun + module init) | ~400 | 116–470 + 837–1103 |

Each cluster has its own natural test surface, its own collaborators,
and near-zero overlap with the others at the method boundary. Merge
conflicts in the god class today are almost entirely because two
developers touch unrelated clusters that happen to share a file.

This phase is a big one. It extracts five new sub-services and
rewrites `ExecutionService` as a thin orchestrator.

## Scope

**In:**

- Create five new files under `src/modules/execution/`:
  - `run-store.service.ts`
  - `worktree.service.ts`
  - `scratchpad.service.ts`
  - `run-interaction.service.ts`
  - `pull-request.service.ts`
  - (and keep `launch-eligibility.service.ts` separate if it crosses
    a natural line, or fold into the orchestrator — TBD during
    implementation)
- Move the method clusters listed above into the right files,
  preserving bodies verbatim where possible and updating field
  accesses (e.g. `this.recentRuns` → `this.runStore.listRecentRuns()`).
- `ExecutionService` becomes the orchestrator: `launch`, `executeRun`,
  `onModuleInit`, plus the two transition wrappers
  (`transitionInProgressToReady/Drafting`) that Phase 3 left in place.
  Target line count: **~500**.
- Remove the Phase 3 temporary seams (`disposeRunFromBuffer`,
  `emitRunExecutionResult`) — those become methods on `RunStore`.
- Rewire `RunDispositionService` to inject `RunStore` directly instead
  of `ExecutionService`, removing the `forwardRef(ExecutionService)`
  added in Phase 3.
- Rewire `RunInteractionService` to be the owner of the
  `disambiguationGates` map and `activeSessions` map — these become
  private fields on the new service instead of on `ExecutionService`.

**Out:**

- No behaviour changes. Every HTTP endpoint's response is byte-identical.
- No new commands or events. Phase 4 is pure refactor.
- No frontend changes. The SSE envelope shape is unchanged.
- No deletion of `ExecutionService.createHsmRunRecord` (orphaned
  since Phase 1) — Phase 9 review pass handles dead code.
- No rename of `ExecutionService` itself. Some readers would prefer
  `ExecutionRunnerService` to match the narrower responsibility, but
  renaming touches every caller and is a Phase 9 cosmetic.

## File changes

### 1. `src/modules/execution/run-store.service.ts`

Owns the in-memory run buffer and all disk persistence primitives:

```typescript
@Injectable()
export class RunStore {
  private readonly recentRuns: ExecutionRunRecord[] = [];
  private readonly recentRunLimit = 16;
  private readonly eventSubject = new Subject<MessageEvent>();
  private eventCounter = 0;
  private readonly artifactRoot = resolve(getConfig().artifactRoot);

  // Buffer operations
  listRecentRuns(): ExecutionRunRecord[];
  getRun(runId: string): ExecutionRunRecord | null;
  upsertRecentRun(run: ExecutionRunRecord): void;
  updateRun(runId: string, patch: Partial<ExecutionRunRecord>): ExecutionRunRecord | null;
  hydrateRecentRunsFromDisk(): void;

  // Disk operations
  persistRun(run: ExecutionRunRecord): void;
  writeStatus(run: ExecutionRunRecord): void;
  writeMetadata(run: ExecutionRunRecord): void;
  writeSummary(run: ExecutionRunRecord, node?: ExecutionDispatchNodePreview): void;
  appendEvent(run: ExecutionRunRecord, payload: Record<string, unknown>): void;

  // Disposition support (replaces Phase 3 seams)
  disposeRunsForWorkItem(workItemId: string, now: () => string): string[];
  captureRunSnapshotForWorkItem(workItemId: string): ExecutionRunRecord[];

  // Streaming
  stream(): Observable<MessageEvent>;
  emitRun(eventType: ExecutionStreamEventType, run: ExecutionRunRecord): void;
}
```

### 2. `src/modules/execution/worktree.service.ts`

```typescript
@Injectable()
export class WorktreeService {
  private readonly worktreeRoot = worktreesRoot(resolve(getConfig().artifactRoot));

  createWorktree(branch: string, baseRef: string): string;
  removeWorktreeAndBranch(run: ExecutionRunRecord): CleanupWorktreeResult;
  evaluateSafety(branch: string, worktreePath: string, baseRef: string): ExecutionSafetyCheck[];
  installDependencies(worktreePath: string): void;
  listChangedFiles(worktreePath: string): string[];
  countCommitsAhead(worktreePath: string, baseRef: string, branch: string): number;
  getWorktreePath(branch: string): string;

  // Shell wrappers (now private to this service)
  private runGit(args: string[], options?: { allowFailure?: boolean }): string;
  private runGitIn(cwd: string, args: string[], options?: { allowFailure?: boolean }): string;
  private runCommand(command: string, args: string[], options: CommandOptions): string;
}
```

### 3. `src/modules/execution/scratchpad.service.ts`

```typescript
@Injectable()
export class ScratchpadService {
  writeScratchpad(run: ExecutionRunRecord, node: ExecutionDispatchNodePreview): ScratchpadWriteResult;
  syncScratchpadToCanonical(run: ExecutionRunRecord): void;
  buildScratchpad(run: ExecutionRunRecord, node: ExecutionDispatchNodePreview): string;

  // Commit guards
  findStagedScratchpadViolations(worktreePath: string): string[];
  findCommittedScratchpadViolations(worktreePath: string, baseRef: string): string[];

  // Checklist + open items parsing
  parseImplementationPlanChecklist(content: string): ChecklistItem[];
  parseScratchpadOpenItems(content: string): { questions: string[]; blockers: string[] };
  readChecklistFromWorktree(run: ExecutionRunRecord): ChecklistItem[];
  emitChecklistIfChanged(run: ExecutionRunRecord): void;
}
```

### 4. `src/modules/execution/run-interaction.service.ts`

Owns the pi-coding-agent session lifecycle, the disambiguation gate,
and follow-up turns:

```typescript
@Injectable()
export class RunInteractionService {
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly disambiguationGates = new Map<string, DisambiguationGate>();

  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(ScratchpadService) private readonly scratchpad: ScratchpadService,
  ) {}

  async createSession(run: ExecutionRunRecord): Promise<AgentSession>;
  async runSetupPhase(run: ExecutionRunRecord, node, workItem, issueBody, projectContext): Promise<void>;
  async runDoWorkPhase(run: ExecutionRunRecord, node, workItem, projectContext): Promise<string>;
  async blockOnDisambiguationGate(runId: string): Promise<string | undefined>;
  resolveDisambiguation(dto: ResolveDisambiguationDto): ResolveDisambiguationResult;
  async sendFollowUp(dto: FollowUpMessageDto): Promise<FollowUpMessageResult>;
  handleSessionEvent(runId: string, event: AgentSessionEvent): void;
  pushActivity(runId: string, kind: ActivityLogEntryKind, message: string, detail?: string): void;
}
```

### 5. `src/modules/execution/pull-request.service.ts`

```typescript
@Injectable()
export class PullRequestService {
  async createPullRequest(dto: CreateExecutionPullRequestDto): Promise<CreateExecutionPullRequestResult>;
  async syncMergedPullRequest(dto: SyncMergedExecutionDto): Promise<SyncMergedExecutionResult>;
  refreshPullRequestTruth(pullRequest, options): { updated_run_ids: string[] };

  // Builders
  private buildPullRequestTitle(workItem: WorkItemRecord): string;
  private buildPullRequestBody(run, workItem, baseRef): string;
  private autoStageAndCommit(run, workItem, commitMessage?): void;
  private buildMergedWorkItemMeta(...): Record<string, unknown>;
  private selectActualFilesForMergeSync(...): { files: string[]; source: string };
  private findRecentRunForSync(workItem, pullRequestNumber): ExecutionRunRecord | null;
  private safeStageManagedBlockSync(workItemId): Promise<ManagedBlockSync | null>;
}
```

### 6. `src/modules/execution/execution.service.ts` (thin orchestrator)

```typescript
@Injectable()
export class ExecutionService implements OnModuleInit {
  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsm: WorkItemHsmService,
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(GitHubService) private readonly github: GitHubService,
    @Inject(GitHubBatchCache) private readonly cache: GitHubBatchCache,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(WorkItemReconcilerService) private readonly reconciler: WorkItemReconcilerService,
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(WorktreeService) private readonly worktree: WorktreeService,
    @Inject(ScratchpadService) private readonly scratchpad: ScratchpadService,
    @Inject(RunInteractionService) private readonly interaction: RunInteractionService,
  ) {
    this.github.registerPullRequestTruthRefresher((pr, options) =>
      this.pullRequestService.refreshPullRequestTruth(pr, options));
  }

  async onModuleInit(): Promise<void>;

  // Public orchestration API
  async launch(dto: LaunchExecutionRunDto): Promise<LaunchExecutionRunResult>;
  getPreview(repo?: string): ExecutionDispatchPreview;
  getLaunchEligibility(workItemId?: string, baseRef?: string): ExecutionLaunchEligibility;
  async transitionInProgressToReady(workItemId: string): Promise<WorkItemRecord>;
  async transitionInProgressToDrafting(workItemId: string): Promise<WorkItemRecord>;
  listRecentRuns(): ExecutionRunRecord[];       // delegates to runStore
  getRunActivityLog(runId: string): ActivityLogEntry[];
  getRunChatHistory(runId: string): RunChatHistory;
  getRunChecklist(runId: string): ExecutionChecklistSnapshot;
  getRunScratchpad(runId: string): { run_id: string; content: string | null };
  stream(): Observable<MessageEvent>;           // delegates to runStore
  listArchivedRunBundles(): ArchivedRunBundle[];
  getArchivedRunBundle(workItemId: string): ArchivedRunBundle;

  // The orchestrator internals
  private async executeRun(run: ExecutionRunRecord, node: ExecutionDispatchNodePreview, disambiguate: boolean): Promise<void>;
  private async markWorkItemInProgressOnLaunch(workItem: WorkItemRecord): Promise<{ workItem; transitioned: boolean }>;
  private buildSetupPrompt(...): string;
  private buildDoWorkPrompt(...): string;
  private createRunRecord(input): ExecutionRunRecord;  // private helper, still called by launch
}
```

Target: **~500 lines**, down from ~2500 at the start of the phase.

### 7. `src/modules/execution/execution.module.ts`

Add the five new sub-services to `providers`. `exports` adds
`RunStore` (so `RunDispositionService` can import it), `WorktreeService`,
`ScratchpadService`, `RunInteractionService`, `PullRequestService`.

### 8. `src/modules/execution/run-disposition.service.ts`

Remove `forwardRef(ExecutionService)`. Add `@Inject(RunStore)` and
delegate buffer mutations to it. The forwardRef from Phase 3 is gone.

## Tests

**New:**
- One test file per new sub-service
  (`run-store.service.test.ts`, `worktree.service.test.ts`,
  `scratchpad.service.test.ts`, `run-interaction.service.test.ts`,
  `pull-request.service.test.ts`). Each constructed with stubbed
  collaborators — no Nest DI.

**Moved:**
- Existing tests in `execution.service.test.ts`, `build-scratchpad.test.ts`,
  `parse-checklist.test.ts`, `parse-scratchpad-open-items.test.ts`,
  `scratchpad-canonical.test.ts`, `scratchpad-commit-guards.test.ts`,
  `launch-eligibility.test.ts`, `follow-up-types.test.ts`,
  `execution-rehydrate.test.ts` are reorganized so each file tests
  the service that now owns its subject.

**Kept:**
- `execution.service.test.ts` shrinks to cover only orchestration:
  `launch` happy path, `launch` blocked path, `executeRun` end-to-end
  with stubbed sub-services, transition wrappers.

## Acceptance criteria

- [ ] `src/modules/execution/execution.service.ts` line count under 600
- [ ] Five new sub-service files exist, each `@Injectable`, each
      registered in `execution.module.ts`
- [ ] `RunDispositionService` no longer `forwardRef()`s `ExecutionService`
- [ ] All previously passing tests still pass after being moved
- [ ] Every HTTP route in `ExecutionController` returns identical
      responses to its pre-phase behaviour (smoke via saved fixtures
      or manual curl comparison)
- [ ] SSE `execution_status` / `execution_result` envelopes are
      byte-identical to pre-phase output
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` sums to **8**

## Known remaining drift

- `ExecutionService` still injects eight collaborators. That's a lot
  for an orchestrator. Phase 5 may trim some of them by moving direct
  calls to event dispatch.
- `createHsmRunRecord` is still orphaned. Phase 9 deletes it.
- The `launch()` / `executeRun()` split has a weird seam where
  `launch` returns the queued run and `executeRun` is fire-and-forget
  in the background. Phase 5 considers whether to surface the
  background flow as an event sequence.
- The `GitHubService.registerPullRequestTruthRefresher` callback
  handshake is still bespoke. Phase 5's event-driven pass replaces it
  with `PullRequestTruthRefreshedEvent` if the semantics fit.

## Next

[Phase 5](phase-5-event-driven-cross-context.md) takes the extracted
sub-services and picks specific cross-context calls to replace with
event dispatch. Per-event analysis, not a blanket sweep.
