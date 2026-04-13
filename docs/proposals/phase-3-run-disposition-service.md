# Phase 3 — Extract `RunDispositionService` from the god class

**Status:** proposed
**Predecessors:** [phase-2-work-items-controller-command-bus.md](phase-2-work-items-controller-command-bus.md)
**Successors:** [phase-4-execution-sub-services.md](phase-4-execution-sub-services.md)
**Estimated effort:** 2–3 days
**Net forwardRef change:** **0** (8 → 8)

## Motivation

After Phases 1 and 2, `ExecutionService` is still ~3286 lines and the
largest functional cluster inside it — roughly 800 lines — is the
merged-PR disposition flow plus cancel/delete. See
[`assessment.md`](assessment.md) §3 for the full functional-cluster
map. The cluster boundaries are clean:

| Range | Function |
|---:|---|
| 2444–2532 | `closeMergedPullRequest` |
| 2554–2630 | `removeRunsForWorkItem` |
| 2632–2742 | `archiveAndCloseMergedPullRequest` |
| 2744–2775 | `captureRunSnapshotForWorkItem` |
| 2785–2835 | `cancelWorkItem` |
| 2837–2905 | `deleteWorkItem` |
| 2907–2937 | `assertCancelEligible` / `assertDeleteEligible` / `leafState` |
| 2938–2986 | `assertWorkItemInMergedPr` / `assertNoActiveRunForWorkItem` |
| 3001–3080 | `archiveRunArtifacts` / `movePlanDirToArchives` |

All of it is "given a work item, put it into a terminal state and
tidy up the filesystem + GitHub + run buffer." That's one
responsibility. It's currently tangled with run execution (which owns
`launch`, `executeRun`, session management) purely because both live
on the same 3000-line class.

This phase extracts the disposition cluster into a dedicated
`RunDispositionService`. The six `@CommandHandler` classes Phase 2
created (`CancelWorkItemHandler`, `DeleteWorkItemHandler`,
`CloseMergedPullRequestHandler`, `ArchiveAndCloseMergedPullRequestHandler`,
plus two transition handlers) lose their `ExecutionService` injection
and point at the new sub-service directly. The `HsmActionHandlers.runArchiver`
method loses its temporary `getArtifactRoot` / `logWarn` calls — those
were Phase 1 injection seams that Phase 3 makes unnecessary.

## Scope

**In:**

- Create `src/modules/execution/run-disposition.service.ts` with the
  methods listed in §File changes below.
- Move the nine methods from `ExecutionService` into it, keeping the
  exact bodies except for dependency rewiring (inject `WorkItemsService`,
  `WorkItemHsmService`, `GitHubService`, `GitHubBatchCache`,
  `PlansService`, plus new internal helpers).
- Delete the temporary public seams added in Phase 1
  (`getArtifactRoot`, `logWarn`, public `captureRunSnapshotForWorkItem`,
  public `movePlanDirToArchives`). They become private methods on the
  new sub-service.
- Rewrite the six command handlers from Phase 2 to inject
  `RunDispositionService` instead of `ExecutionService`.
- Rewrite `HsmActionHandlers.runArchiver` to call
  `runDisposition.archiveRunArtifactsAction(workItem, ctx)` instead of
  the three ExecutionService calls.
- Register `RunDispositionService` as a provider in
  `ExecutionModule`, export it so other modules (notably
  `ReconciliationModule` in Phase 8) can inject it directly.
- Move disposition tests out of `execution.service.test.ts` into
  `run-disposition.service.test.ts`.

**Out:**

- No changes to the disposition flow's behaviour. Every HTTP response
  envelope and every SSE event stays byte-identical.
- No changes to `ExecutionService.launch`, `executeRun`, or the
  pi-agent session lifecycle. Those are Phase 4.
- No rename of methods. `closeMergedPullRequest` stays
  `closeMergedPullRequest` on the new class — the command handler's
  public name is what drives the HTTP surface.
- No new events. The disposition flow keeps dispatching
  `user.finalize` / `user.archive_and_finalize` / `user.cancel`
  through the HSM exactly as today. Event dispatch is Phase 5.

## File changes

### 1. `src/modules/execution/run-disposition.service.ts` (new)

```typescript
@Injectable()
export class RunDispositionService {
  private readonly logger = new Logger(RunDispositionService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);

  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsm: WorkItemHsmService,
    @Inject(GitHubService) private readonly github: GitHubService,
    @Inject(GitHubBatchCache) private readonly cache: GitHubBatchCache,
    @Inject(forwardRef(() => PlansService)) private readonly plans: PlansService,
    @Inject(forwardRef(() => ExecutionService)) private readonly execution: ExecutionService,
  ) {}

  // Migrated from ExecutionService, public API:
  async closeMergedPullRequest(id: string): Promise<CloseMergedPullRequestResult>;
  async archiveAndCloseMergedPullRequest(id: string): Promise<ArchiveAndCloseMergedPullRequestResult>;
  async cancelWorkItem(input: CancelWorkItemDto): Promise<CancelWorkItemResult>;
  async deleteWorkItem(input: DeleteWorkItemDto): Promise<DeleteWorkItemResult>;
  archiveRunArtifacts(workItemId: string): ArchiveRunArtifactsResult;

  // Called by HsmActionHandlers.runArchiver:
  async archiveRunArtifactsAction(
    workItem: WorkItemRecord,
    ctx: HsmActionHandlerContext,
  ): Promise<void>;

  // Private finalizers, migrated from ExecutionService:
  private captureRunSnapshotForWorkItem(id: string): ExecutionRunRecord[];
  private removeRunsForWorkItem(id: string): string[];
  private movePlanDirToArchives(id: string): { moved: boolean; archive_path: string | null };
  private assertWorkItemInMergedPr(id: string): WorkItemRecord;
  private assertNoActiveRunForWorkItem(id: string): void;
  private assertCancelEligible(workItem: WorkItemRecord): void;
  private assertDeleteEligible(workItem: WorkItemRecord): void;
  private leafState(state: string): string;
}
```

The forwardRef on `ExecutionService` is because `removeRunsForWorkItem`
still needs to splice the in-memory `recentRuns` buffer and emit
`execution_result` SSE events — both of which are owned by
`ExecutionService` in Phase 3. Phase 4 extracts a `RunStore`
sub-service and `RunDispositionService` injects that instead, breaking
the forwardRef.

### 2. `src/modules/execution/execution.service.ts`

Delete the nine methods and the helpers they call:

- `closeMergedPullRequest`, `archiveAndCloseMergedPullRequest`,
  `cancelWorkItem`, `deleteWorkItem`, `archiveRunArtifacts`
- `captureRunSnapshotForWorkItem`, `removeRunsForWorkItem`,
  `movePlanDirToArchives`
- `assertWorkItemInMergedPr`, `assertNoActiveRunForWorkItem`,
  `assertCancelEligible`, `assertDeleteEligible`, `leafState`
- Temporary Phase 1 public seams: `getArtifactRoot`, `logWarn`

Add public accessors on `ExecutionService` for the in-memory run
buffer so `RunDispositionService.removeRunsForWorkItem` can call them:

- `disposeRunFromBuffer(runId: string, disposedAt: string): ExecutionRunRecord | null`
- `emitRunExecutionResult(run: ExecutionRunRecord): void`

These are temporary seams (Phase 4 makes them methods on the
extracted `RunStore`). Mark with `// TODO(phase-4)`.

Expected size after Phase 3: ~2500 lines.

### 3. `src/modules/execution/hsm-action-handlers.ts`

Update the `runArchiver` method from Phase 1:

```typescript
async runArchiver(
  workItem: WorkItemRecord,
  _event: WorkItemHsmEvent,
  ctx: HsmActionHandlerContext,
): Promise<void> {
  await this.disposition.archiveRunArtifactsAction(workItem, ctx);
}
```

Replace the `@Inject(ExecutionService)` constructor field with
`@Inject(RunDispositionService)`. `closeGhIssue` is unchanged.

### 4. Command handler rewires (from Phase 2)

Each of the six command handler files gets a one-line constructor
change:

```diff
- @Inject(ExecutionService) private readonly execution: ExecutionService,
+ @Inject(RunDispositionService) private readonly disposition: RunDispositionService,
```

And the `execute` body updates the method name accordingly. The two
transition handlers (`TransitionInProgressToReadyHandler` /
`TransitionInProgressToDraftingHandler`) keep injecting
`ExecutionService` for now — those methods didn't move.

### 5. `src/modules/execution/execution.module.ts`

Add `RunDispositionService` to `providers` and `exports`.

## Tests

**New:**
- `src/modules/execution/__tests__/run-disposition.service.test.ts` —
  adopts the existing disposition tests from
  `execution.service.test.ts` / `disposition.test.ts` with minimal
  changes. Test harness constructs the sub-service directly with
  stubbed collaborators — no Nest DI needed.

**Moved:**
- Disposition-related `describe` blocks in the existing
  `disposition.test.ts` (currently under `execution/__tests__/`) move
  to the new file.

**Deleted:**
- Any `ExecutionService` test cases that covered the moved methods.
  Replacements live in the new sub-service test file.

## Acceptance criteria

- [ ] `src/modules/execution/run-disposition.service.ts` exists, is
      `@Injectable`, and is exported from ExecutionModule
- [ ] `ExecutionService` no longer defines `closeMergedPullRequest`,
      `archiveAndCloseMergedPullRequest`, `cancelWorkItem`,
      `deleteWorkItem`, `archiveRunArtifacts` (verify by grep)
- [ ] `ExecutionService` line count drops below 2700
- [ ] `HsmActionHandlers.runArchiver` injects
      `RunDispositionService`, not `ExecutionService`
- [ ] Command handlers for cancel/delete/close/archive inject
      `RunDispositionService`
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` still sums to
      **8** (no change from Phase 2)
- [ ] `npm test` passes
- [ ] End-to-end smoke: merged-PR close, merged-PR archive-and-close,
      cancel pre-PR, delete pre-PR all succeed with identical HTTP
      envelopes as before

## Known remaining drift

- `RunDispositionService` still `forwardRef()`s `ExecutionService` for
  the run-buffer mutation seams (`disposeRunFromBuffer`,
  `emitRunExecutionResult`). Phase 4 extracts a `RunStore` and
  removes the forwardRef.
- `ExecutionService` is still ~2500 lines. Phase 4 extracts the
  remaining clusters (worktree, pull-request, scratchpad,
  run-interaction) to get it to ~500 lines.
- The `transitionInProgressToReady` / `transitionInProgressToDrafting`
  methods stay on `ExecutionService` because they're pure HSM dispatch
  wrappers and there's no natural sub-service home for them. Phase 9
  review decides whether they deserve their own tiny service or should
  stay where they are.

## Next

[Phase 4](phase-4-execution-sub-services.md) continues the god-class
extraction: `WorktreeService`, `PullRequestService`,
`ScratchpadService`, `RunInteractionService`, and `RunStore`.
`ExecutionService` becomes a thin orchestrator.
