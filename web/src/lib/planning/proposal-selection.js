// Selection and display helpers for a graph mutation proposal (#281).
// Pure functions: the review component and its tests share them.

/** @typedef {{ id: string, type: string, entity_id?: string, payload?: any, rationale?: string, validation?: any, group_id?: string, depends_on_mutation_ids?: string[] }} Mutation */
/** @typedef {{ proposal_id: string, mutations?: Mutation[], source?: { agent?: string } }} Proposal */

/** @param {Mutation} mutation */
export function mutationErrors(mutation) {
    const errors = mutation?.validation?.errors;
    return Array.isArray(errors) ? errors : [];
}

/**
 * What is ticked when a proposal first appears: everything that passed
 * validation. A mutation with errors starts unticked, and so does an
 * edge whose new node is unticked, so "Approve" works without editing.
 * @param {Proposal | null} proposal
 * @returns {string[]}
 */
export function defaultSelection(proposal) {
    const mutations = proposal?.mutations ?? [];
    const excluded = new Set(mutations.filter((mutation) => mutationErrors(mutation).length > 0).map((mutation) => mutation.id));
    for (const mutation of mutations) {
        if ((mutation.depends_on_mutation_ids ?? []).some((id) => excluded.has(id)))
            excluded.add(mutation.id);
    }
    return mutations.filter((mutation) => !excluded.has(mutation.id)).map((mutation) => mutation.id);
}

/**
 * Tick or untick one mutation, keeping edges and the nodes they need
 * together: unticking a node unticks the edges that depend on it, and
 * ticking an edge ticks its nodes. An edge can be unticked on its own.
 * @param {Proposal | null} proposal
 * @param {string[]} selectedIds
 * @param {string} id
 * @param {boolean} checked
 * @returns {string[]}
 */
export function toggleSelection(proposal, selectedIds, id, checked) {
    const mutations = proposal?.mutations ?? [];
    const selected = new Set(selectedIds);
    if (checked) {
        selected.add(id);
        for (const dependency of mutations.find((mutation) => mutation.id === id)?.depends_on_mutation_ids ?? []) {
            if (mutations.some((mutation) => mutation.id === dependency))
                selected.add(dependency);
        }
    }
    else {
        selected.delete(id);
        for (const mutation of mutations) {
            if ((mutation.depends_on_mutation_ids ?? []).includes(id))
                selected.delete(mutation.id);
        }
    }
    return mutations.filter((mutation) => selected.has(mutation.id)).map((mutation) => mutation.id);
}

/**
 * Mutations in review order: one block per group (an issue's node first,
 * then its edges), ungrouped mutations each on their own.
 * @param {Proposal | null} proposal
 * @returns {Array<{ key: string, mutations: Mutation[] }>}
 */
export function groupMutations(proposal) {
    /** @type {Map<string, { key: string, mutations: Mutation[] }>} */
    const groups = new Map();
    for (const mutation of proposal?.mutations ?? []) {
        const key = mutation.group_id ?? `mutation:${mutation.id}`;
        const group = groups.get(key);
        if (group)
            group.mutations.push(mutation);
        else
            groups.set(key, { key, mutations: [mutation] });
    }
    for (const group of groups.values()) {
        group.mutations.sort((left, right) => Number(right.type === "create_work_item") - Number(left.type === "create_work_item"));
    }
    return [...groups.values()];
}

/**
 * Where a proposed edge comes from, for the review label. Text the issue
 * author wrote is "deterministic"; an edge marked inferred or ambiguous
 * is a model suggestion. Returns null for an edge with neither.
 * @param {Mutation} mutation
 * @returns {{ kind: "deterministic" | "inferred", label: string, quotes: Array<{ issue: string, quote: string }> } | null}
 */
export function edgeEvidence(mutation) {
    if (mutation?.type !== "create_edge")
        return null;
    const evidence = Array.isArray(mutation.payload?.meta?.evidence) ? mutation.payload.meta.evidence : [];
    const quotes = evidence
        .filter((/** @type {any} */ entry) => entry && typeof entry.quote === "string")
        .map((/** @type {any} */ entry) => ({ issue: String(entry.issue ?? ""), quote: entry.quote }));
    const confidence = mutation.payload?.confidence;
    if (confidence === "inferred" || confidence === "ambiguous")
        return { kind: "inferred", label: "model-inferred", quotes };
    if (evidence.some((/** @type {any} */ entry) => entry?.source === "issue_body"))
        return { kind: "deterministic", label: "from issue text", quotes };
    return null;
}

/** @param {Proposal | null} proposal */
export function isImportProposal(proposal) {
    return proposal?.source?.agent === "issue-import";
}
