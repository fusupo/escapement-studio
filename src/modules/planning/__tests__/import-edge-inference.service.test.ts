import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ create: vi.fn(), reload: vi.fn(), loader: vi.fn(), settings: vi.fn(), memory: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: sdk.create, getAgentDir: () => "/agent",
  DefaultResourceLoader: class { constructor(options: unknown) { sdk.loader(options); } reload = sdk.reload; },
  SettingsManager: { inMemory: sdk.settings }, SessionManager: { inMemory: sdk.memory },
}));
import { buildImportInferencePrompt, ImportEdgeInferenceService, INFERENCE_LIMITS, parseImportInference, type ImportInferenceInput } from "../import-edge-inference.service.js";
const edge = { from_id: "new", rel: "depends_on", to_id: "old", confidence: "inferred", rationale: "Required groundwork" };
const input: ImportInferenceInput = { repo: "a/b", issues: [{ id: "new", title: "Import", body: "Needs groundwork" }], nodes: [{ id: "old", name: "Groundwork", kind: "issue", repo: "a/b", scope_hint: null }], edges: [] };
const session = (text = '{"edges":[]}') => ({ prompt: vi.fn(async () => {}), getLastAssistantText: vi.fn(() => text), messages: [], abort: vi.fn(async () => {}), dispose: vi.fn() });
const settings = { getSelectedModel: vi.fn(() => ({ id: "selected" })) };
const service = () => new ImportEdgeInferenceService(settings as never);
beforeEach(() => { vi.clearAllMocks(); sdk.reload.mockResolvedValue(undefined); sdk.settings.mockReturnValue({}); settings.getSelectedModel.mockReturnValue({ id: "selected" }); });
afterEach(() => vi.useRealTimers());

describe("import inference parsing", () => {
  it("accepts empty, fenced and valid output, discarding untrusted metadata", () => {
    expect(parseImportInference('{"edges":[]}')).toEqual([]);
    expect(parseImportInference('```json\n' + JSON.stringify({ edges: [{ ...edge, payload: {}, id: "unsafe" }] }) + '\n```')).toEqual([edge]);
  });
  it.each(["", "prose {}", "[]", "null", "{}", '{"edges":{}}'])("rejects envelope %s", (text) => expect(() => parseImportInference(text)).toThrow());
  it("drops invalid siblings, unknown enums, empty fields and long rationale", () => {
    const invalid = [null, [], 3, { ...edge, rel: "implemented_by" }, { ...edge, confidence: "certain" }, { ...edge, from_id: " " }, { ...edge, to_id: 3 }, { ...edge, rationale: " " }, { ...edge, rationale: "x".repeat(2001) }];
    expect(parseImportInference(JSON.stringify({ edges: [...invalid, { ...edge, from_id: " new ", rationale: " okay " }] }))).toEqual([{ ...edge, rationale: "okay" }]);
    expect(() => parseImportInference("x".repeat(100001))).toThrow(/too_large/);
    expect(parseImportInference(JSON.stringify({ edges: Array(101).fill(edge) }))).toHaveLength(100);
  });
});

describe("bounded inference context", () => {
  const data = (prompt: string) => JSON.parse(prompt.split("<import-data>\n")[1].split("\n</import-data>")[0]);
  it("serializes untrusted text, direction instructions and compact fields deterministically", () => {
    const nodes = [
      { ...input.nodes[0], id: "z", repo: null, name: "n".repeat(250), scope_hint: "s".repeat(350) },
      { ...input.nodes[0], id: "a", repo: "other/repo" }, input.nodes[0],
    ];
    const a = buildImportInferencePrompt({ ...input, nodes, issues: [{ ...input.issues[0], body: "b".repeat(9000) }] });
    const b = buildImportInferencePrompt({ ...input, nodes: [...nodes].reverse(), issues: [{ ...input.issues[0], body: "b".repeat(9000) }] });
    expect(a).toEqual(b);
    expect(a.prompt).toContain("B is prerequisite"); expect(a.prompt).toContain("B is parent");
    expect(data(a.prompt).nodes.map((n: { id: string }) => n.id)).toEqual(["old", "a", "z"]);
    expect(data(a.prompt).omissions).toMatchObject({ body_characters: 1000, name_characters: 50, scope_characters: 50 });
  });
  it("reserves selected titles, marks omissions and excludes edges touching omitted nodes", () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ ...input.nodes[0], id: `node-${i}`, name: "x".repeat(200), scope_hint: "s".repeat(300) }));
    const result = buildImportInferencePrompt({ ...input, issues: [{ id: "new", title: "T".repeat(20000), body: "b".repeat(10000) }], nodes, edges: [{ from_id: "node-0", rel: "depends_on", to_id: "node-999" }] });
    expect(result.prompt.length).toBeLessThan(INFERENCE_LIMITS.prompt);
    expect(data(result.prompt).issues[0].title).toHaveLength(20000);
    expect(data(result.prompt).omissions.graph_nodes).toBeGreaterThan(0);
    expect(result.endpointIds).not.toContain("node-999");
    expect(data(result.prompt).edges).toEqual([]);
    expect(() => buildImportInferencePrompt({ ...input, issues: [{ id: "new", title: "T".repeat(100000), body: "" }] })).toThrow(/mandatory/);
  });
});

describe("isolated model lifecycle", () => {
  it("uses the selected model with no tools/resources and cleans up success", async () => {
    const s = session(); sdk.create.mockResolvedValue({ session: s });
    expect(await service().infer(input)).toEqual({ edges: [], endpointIds: ["new", "old"] });
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ model: { id: "selected" }, noTools: "all", customTools: [] }));
    expect(sdk.settings).toHaveBeenCalledWith({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = sdk.loader.mock.calls[0][0];
    expect(loader).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    expect(loader.appendSystemPromptOverride()).toEqual([]); expect(loader.agentsFilesOverride()).toEqual({ agentsFiles: [] });
    expect(loader.systemPromptOverride()).toContain("untrusted");
    expect(sdk.reload).toHaveBeenCalledTimes(1);
    expect(s.prompt).toHaveBeenCalledWith(expect.stringContaining('"title":"Import"'), { expandPromptTemplates: false });
    expect(s.dispose).toHaveBeenCalledTimes(1); expect(s.abort).toHaveBeenCalledTimes(1);
  });
  it.each(["", "bad JSON", "{}", "x".repeat(100001)])("retries malformed/empty/oversized output in fresh sessions (case %#)", async (text) => {
    const a = session(text), b = session(JSON.stringify({ edges: [edge] }));
    sdk.create.mockResolvedValueOnce({ session: a }).mockResolvedValueOnce({ session: b });
    expect((await service().infer(input)).edges).toEqual([edge]);
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });
  it("bounds prompt errors/context-limit failures and exhaustion", async () => {
    const a = session(), b = session(); a.prompt.mockRejectedValue(new Error("context limit private text")); b.prompt.mockRejectedValue(new Error("provider private text"));
    sdk.create.mockResolvedValueOnce({ session: a }).mockResolvedValueOnce({ session: b });
    await expect(service().infer(input)).rejects.toThrow("inference_attempts_exhausted");
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b.dispose).toHaveBeenCalledTimes(1);
  });
  it("retries model error turns even if they contain apparently valid text", async () => {
    const a = { ...session(), messages: [{ role: "assistant", stopReason: "error" }] }, b = session();
    sdk.create.mockResolvedValueOnce({ session: a }).mockResolvedValueOnce({ session: b });
    expect((await service().infer(input)).edges).toEqual([]);
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not prompt a session resolving at the deadline before its timer callback", async () => {
    vi.useFakeTimers(); const s = session();
    sdk.create.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 60000); return { session: s }; });
    await expect(service().infer(input)).rejects.toThrow("deadline");
    expect(s.prompt).not.toHaveBeenCalled(); expect(s.dispose).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the deadline timer after success and parse exhaustion", async () => {
    vi.useFakeTimers(); sdk.create.mockResolvedValueOnce({ session: session() });
    await service().infer(input); expect(vi.getTimerCount()).toBe(0);
    const a = session("bad"), b = session("bad");
    sdk.create.mockResolvedValueOnce({ session: a }).mockResolvedValueOnce({ session: b });
    await expect(service().infer(input)).rejects.toThrow("exhausted");
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b.dispose).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retry setup errors", async () => {
    sdk.create.mockRejectedValue(new Error("setup"));
    await expect(service().infer(input)).rejects.toThrow("setup"); expect(sdk.create).toHaveBeenCalledTimes(1);
  });
  it("does not create a session after loader failure or oversized mandatory fields", async () => {
    sdk.reload.mockRejectedValueOnce(new Error("loader"));
    await expect(service().infer(input)).rejects.toThrow("loader");
    await expect(service().infer({ ...input, issues: [{ id: "n", title: "t".repeat(100000), body: null }] })).rejects.toThrow(/mandatory/);
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it("aborts active work at a shared deadline, with no retry or timer leak", async () => {
    vi.useFakeTimers();
    const a = session("bad"), b = session();
    a.prompt.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 40000)); });
    b.prompt.mockImplementation(() => new Promise(() => {}));
    sdk.create.mockResolvedValueOnce({ session: a }).mockResolvedValueOnce({ session: b });
    const done = expect(service().infer(input)).rejects.toThrow("inference_deadline");
    await vi.advanceTimersByTimeAsync(60000); await done;
    expect(sdk.create).toHaveBeenCalledTimes(2); expect(b.abort).toHaveBeenCalled(); expect(b.dispose).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("disposes late-created sessions without prompting", async () => {
    vi.useFakeTimers(); const s = session();
    let resolve!: (result: { session: typeof s }) => void;
    sdk.create.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const done = expect(service().infer(input)).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(60000); await done;
    resolve({ session: s }); await vi.advanceTimersByTimeAsync(0);
    expect(s.prompt).not.toHaveBeenCalled(); expect(s.dispose).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("observes late creation rejection and bounds loader setup", async () => {
    vi.useFakeTimers(); let reject!: (e: Error) => void;
    sdk.create.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const done = expect(service().infer(input)).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(60000); await done; reject(new Error("late")); await vi.advanceTimersByTimeAsync(0);
    sdk.reload.mockImplementation(() => new Promise(() => {}));
    const second = expect(service().infer(input)).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(60000); await second;
    expect(sdk.create).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
