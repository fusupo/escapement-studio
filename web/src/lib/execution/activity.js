import { sendFollowUpMessage } from "../api.js";
/** activity for the execution workspace. */
export function createActivity(s, actions) {
    function canSendFollowUp(run) {
        return ["running", "preparing", "completed"].includes(run.status);
    }
    async function handleSendFollowUp(run) {
        const text = (s.followUpTexts[run.run_id] || "").trim();
        if (!text)
            return;
        s.sendingFollowUp = { ...s.sendingFollowUp, [run.run_id]: true };
        s.error = "";
        s.followUpTexts = { ...s.followUpTexts, [run.run_id]: "" };
        try {
            const delivery = ["running", "preparing"].includes(run.status) ? "followUp" : undefined;
            const result = await sendFollowUpMessage({ run_id: run.run_id, message: text, ...(delivery ? { delivery } : {}) });
            if (!result.accepted)
                s.error = result.error || "Follow-up was not accepted.";
        }
        catch (e) {
            s.error = e.message;
        }
        finally {
            s.sendingFollowUp = { ...s.sendingFollowUp, [run.run_id]: false };
        }
    }
    function runStatusTone(run) {
        if (run?.terminal_outcome?.severity === "warn")
            return "warn";
        if (run?.status === "completed")
            return "healthy";
        if (["running", "preparing", "queued"].includes(run?.status))
            return "info";
        if (run?.status === "disambiguating")
            return "disambiguating";
        if (run?.status === "blocked")
            return "warn";
        if (run?.status === "error")
            return "danger";
        return "";
    }
    function formatActivityTime(value) {
        if (!value)
            return "";
        try {
            return new Date(value).toLocaleTimeString();
        }
        catch {
            return "";
        }
    }
    function activityIcon(kind) {
        if (kind === "tool_start")
            return "gear";
        if (kind === "tool_end")
            return "check";
        if (kind === "turn_start" || kind === "turn_end")
            return "loop";
        if (kind === "reasoning")
            return "idea";
        if (kind === "error")
            return "err";
        if (kind === "status_change")
            return "pin";
        return "info";
    }
    function activityKindColor(kind) {
        if (kind === "error")
            return "var(--red, #f85149)";
        if (kind === "tool_start" || kind === "tool_end")
            return "var(--accent, #2563eb)";
        if (kind === "status_change")
            return "var(--green, #3fb950)";
        if (kind === "reasoning")
            return "var(--yellow, #d29922)";
        if (kind === "turn_start" || kind === "turn_end")
            return "var(--purple, #a371f7)";
        if (kind === "follow_up")
            return "#58a6ff";
        return "var(--text-muted, #566070)";
    }
    function groupByTurn(activityLog) {
        if (!activityLog?.length)
            return [];
        const groups = [];
        let current = { turnIndex: 0, entries: [] };
        for (const entry of activityLog) {
            if (entry.kind === "turn_start" && current.entries.length > 0) {
                groups.push(current);
                current = { turnIndex: current.turnIndex + 1, entries: [] };
            }
            current.entries.push(entry);
        }
        if (current.entries.length > 0)
            groups.push(current);
        return groups;
    }
    function toggleMessageExpand(idx) {
        s.expandedMessages = { ...s.expandedMessages, [idx]: !s.expandedMessages[idx] };
    }
    function shouldCollapse(text) {
        return text ? text.split("\n").length > s.COLLAPSE_LINE_THRESHOLD : false;
    }
    function truncateText(text) {
        return text.split("\n").slice(0, s.COLLAPSE_LINE_THRESHOLD).join("\n");
    }
    function handleFollowUpKeydown(event, run) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (actions.canSendFollowUp(run))
                actions.handleSendFollowUp(run);
        }
    }
    return { canSendFollowUp, handleSendFollowUp, runStatusTone, formatActivityTime, activityIcon, activityKindColor, groupByTurn, toggleMessageExpand, shouldCollapse, truncateText, handleFollowUpKeydown };
}
