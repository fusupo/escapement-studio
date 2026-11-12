import { resolveDisambiguation } from "../api.js";
import { projectRefinementResponses, refinementResponseKey } from "../execution-refinement.js";
/** refinement actions for the execution workspace. */
export function createRefinementActions(s, actions) {
    function loadRefinementDrafts() {
        if (typeof window === "undefined")
            return {};
        try {
            const value = JSON.parse(window.sessionStorage.getItem(s.REFINEMENT_DRAFTS_KEY) || "{}");
            return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        }
        catch {
            return {};
        }
    }
    function persistRefinementDrafts(value) {
        if (typeof window === "undefined")
            return;
        try {
            window.sessionStorage.setItem(s.REFINEMENT_DRAFTS_KEY, JSON.stringify(value));
        }
        catch {
            // Draft persistence is a convenience; storage restrictions must not
            // prevent answering or confirming a refinement.
        }
    }
    function setRefinementResponse(run, item, draft) {
        s.refinementResponses = {
            ...s.refinementResponses,
            [refinementResponseKey(run.run_id, item.id)]: draft,
        };
        actions.persistRefinementDrafts(s.refinementResponses);
    }
    function clearRefinementResponses(runId) {
        s.refinementResponses = Object.fromEntries(Object.entries(s.refinementResponses).filter(([key]) => !key.startsWith(`${runId}:`)));
        actions.persistRefinementDrafts(s.refinementResponses);
    }
    function setRefinementDrawerClosed(runId, closed) {
        s.refinementDrawerClosed = { ...s.refinementDrawerClosed, [runId]: closed };
    }
    function clampRefinementDrawerWidth(width, maximum = 1000) {
        return Math.max(480, Math.min(maximum, width));
    }
    function setRefinementDrawerWidth(runId, width, maximum) {
        s.refinementDrawerWidths = {
            ...s.refinementDrawerWidths,
            [runId]: actions.clampRefinementDrawerWidth(width, maximum),
        };
    }
    function startRefinementDrawerResize(event, runId) {
        event.preventDefault();
        s.refinementDrawerResizeCleanup?.();
        const handle = event.currentTarget;
        const drawer = handle.closest(".refinement-drawer");
        if (!drawer)
            return;
        const startX = event.clientX;
        const startWidth = drawer.getBoundingClientRect().width;
        const maximum = Math.max(480, Math.min(1100, window.innerWidth - 120));
        const previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        const move = (moveEvent) => {
            actions.setRefinementDrawerWidth(runId, startWidth + startX - moveEvent.clientX, maximum);
        };
        const stop = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", stop);
            document.body.style.userSelect = previousUserSelect;
            s.refinementDrawerResizeCleanup = null;
        };
        s.refinementDrawerResizeCleanup = stop;
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", stop);
    }
    function handleRefinementDrawerResizeKeydown(event, runId) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
            return;
        event.preventDefault();
        const current = s.refinementDrawerWidths[runId] || Math.min(900, window.innerWidth * 0.52);
        actions.setRefinementDrawerWidth(runId, current + (event.key === "ArrowLeft" ? 32 : -32));
    }
    async function handleResolveDisambiguation(run) {
        s.resolvingDisambiguation = { ...s.resolvingDisambiguation, [run.run_id]: true };
        s.error = "";
        try {
            const ctx = (s.disambiguationContext[run.run_id] || "").trim() || undefined;
            const responses = projectRefinementResponses(run, s.refinementResponses);
            const result = await resolveDisambiguation({
                run_id: run.run_id,
                responses,
                additional_context: ctx,
                confirm_unresolved: !!s.confirmUnresolved[run.run_id],
            });
            if (!result.resolved)
                s.error = result.error || "Failed to resolve.";
            else {
                if (result.run)
                    actions.mergeRun(result.run);
                actions.clearRefinementResponses(run.run_id);
                actions.setRefinementDrawerClosed(run.run_id, true);
                s.disambiguationContext = { ...s.disambiguationContext, [run.run_id]: "" };
                s.confirmUnresolved = { ...s.confirmUnresolved, [run.run_id]: false };
            }
        }
        catch (e) {
            s.error = e.message;
        }
        finally {
            s.resolvingDisambiguation = { ...s.resolvingDisambiguation, [run.run_id]: false };
        }
    }
    return { loadRefinementDrafts, persistRefinementDrafts, setRefinementResponse, clearRefinementResponses, setRefinementDrawerClosed, clampRefinementDrawerWidth, setRefinementDrawerWidth, startRefinementDrawerResize, handleRefinementDrawerResizeKeydown, handleResolveDisambiguation };
}
