/**
 * C2 feasibility demo — disposable supervised Node -> Python cognee worker.
 *
 * Scenarios (all against the disposable proof workspace, guard-enforced):
 *   1. cold startup          : spawn -> ready, latency + RSS
 *   2. scoped add/cognify/search on dataset c2_worker_demo
 *   3. clean shutdown        : exit code 0
 *   4. restart               : persistence verified by re-search
 *   5. structured errors     : unknown op, bad params, missing dataset, malformed line
 *   6. killed worker         : SIGKILL mid-add -> outcome-unknown, NO auto-retry;
 *                              fate reconciled by read-back after restart
 *
 * Outcome semantics for mutating ops (requirement: an interrupted write must be
 * reported as outcome-unknown, never auto-retried):
 *   - worker exited while request in flight -> { code: "WORKER_DIED", outcome: "unknown" }
 *   - reconciliation (read-back) is reported separately, never retried automatically.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PY = process.env.PROOF_PY || path.join(ROOT, "proof", ".venv", "Scripts", "python.exe");
const WORKER = path.join(ROOT, "worker", "worker.py");
const DATASET = "c2_worker_demo";
const MARKER = `C2-WORKER-DEMO-${Date.now()}`;

const ENV = {
  ...process.env,
  OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1", TORCH_NUM_THREADS: "1",
  KUZU_BUFFER_POOL_SIZE: "268435456", PYTHONUNBUFFERED: "1",
  // Vector ops in-process: cognee's default vector subprocess forks leak as
  // orphans on worker death (observed: ladybug file locks held by leftover
  // multiprocessing-fork children, blocking the next worker). A single
  // supervised worker owns its store in-process instead. Same for the graph
  // layer (graph_database_subprocess_enabled also defaults to True and its
  // forks held .lbug locks after SIGKILL).
  VECTOR_DB_SUBPROCESS_ENABLED: "false",
  GRAPH_DATABASE_SUBPROCESS_ENABLED: "false",
};

const results = { marker: MARKER, scenarios: [], timings: {} };
const rec = (scenario, data) => {
  results.scenarios.push({ scenario, ...data });
  console.log(`[${scenario}]`, JSON.stringify(data).slice(0, 300));
};

class WorkerClient {
  constructor(label) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = [];
    this.exited = null;
    this.t0 = Date.now();
  }
  start() {
    this.child = spawn(PY, ["-u", WORKER], { cwd: ROOT, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", () => {}); // diagnostics only
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exited = { code, signal, at_ms: Date.now() - this.t0 };
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          const mutating = p.mutating;
          p.reject(Object.assign(new Error(`${this.label}: worker exited (${code}/${signal})`),
            { code: "WORKER_DIED", outcome: mutating ? "unknown" : "failed", mutating }));
        }
        this.pending.clear();
        resolve(this.exited);
      });
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this._onLine(line));
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("ready timeout")), 300_000);
      const h = (msg) => { if (msg.type === "ready") { clearTimeout(to); this.readyInfo = msg; resolve(msg); } };
      this._onReady = h; this._readyResolve = { resolve, reject };
    });
  }
  _onLine(line) {
    if (line.length > 1024 * 1024 + 64) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "ready") { this._onReady?.(msg); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error?.message || "error"),
      { code: msg.error?.code || "ERROR" }));
  }
  request(op, params = {}, { timeoutMs = 420_000, mutating = false } = {}) {
    if (this.exited) return Promise.reject(Object.assign(
      new Error("worker already exited"), { code: "WORKER_DIED", outcome: mutating ? "unknown" : "failed" }));
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, ...params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${op} timeout after ${timeoutMs}ms`), { code: "TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, mutating });
      this.child.stdin.write(line);
    });
  }
  async shutdown() {
    const t = Date.now();
    try { await this.request("shutdown", {}, { timeoutMs: 60_000 }); } catch { /* may race */ }
    await this.exitPromise;
    return Date.now() - t;
  }
  async kill() { this.child.kill("SIGKILL"); await this.exitPromise; }
}

const searchChunks = (c, query) =>
  c.request("search", { query, search_type: "CHUNKS" }, { timeoutMs: 180_000 })
    .then((r) => r.hits ?? []);

async function main() {
  // ---- 1. cold startup ----
  let c1 = new WorkerClient("cold");
  let t = Date.now();
  await c1.start();
  const coldStartMs = Date.now() - t;
  results.timings.cold_start_ms = coldStartMs;
  rec("startup-cold", { ms: coldStartMs, import_ms: c1.readyInfo.import_ms, rss_bytes: c1.readyInfo.rss_bytes });

  // wipe any previous demo dataset (typed failure expected on first run)
  try { await c1.request("forget_dataset", { dataset: DATASET }, { timeoutMs: 60_000, mutating: true }); }
  catch (e) { rec("pre-wipe", { outcome: "expected-typed-failure", code: e.code }); }

  // ---- 2. scoped add/cognify/search ----
  t = Date.now();
  await c1.request("add", { dataset: DATASET, text: `${MARKER} Quellight ingestion contract alpha: settlement windows close at 17:00 UTC.` }, { mutating: true });
  const addMs = Date.now() - t;
  t = Date.now();
  await c1.request("cognify", { datasets: [DATASET] }, { timeoutMs: 420_000, mutating: true });
  const cognifyMs = Date.now() - t;
  t = Date.now();
  const hits = await searchChunks(c1, "settlement windows");
  const searchMs = Date.now() - t;
  const markerHits = hits.filter((h) => JSON.stringify(h).includes(MARKER)).length;
  rec("scoped-sequence", { add_ms: addMs, cognify_ms: cognifyMs, search_ms: searchMs,
    hits: hits.length, marker_hits: markerHits, scope_note: "ops carry dataset name; search scope recorded for C2 findings" });
  results.timings.add_ms = addMs; results.timings.cognify_ms = cognifyMs; results.timings.search_ms = searchMs;
  const rss = await c1.request("status");
  rec("memory-after-cognify", rss);

  // ---- 3. clean shutdown ----
  const shutdownMs = await c1.shutdown();
  results.timings.clean_shutdown_ms = shutdownMs;
  rec("clean-shutdown", { ms: shutdownMs, exit: c1.exited });

  // ---- 4. restart with persistent data ----
  t = Date.now();
  let c2 = new WorkerClient("warm");
  await c2.start();
  const warmStartMs = Date.now() - t;
  results.timings.warm_start_ms = warmStartMs;
  t = Date.now();
  const hits2 = await searchChunks(c2, "settlement windows");
  const search2Ms = Date.now() - t;
  const persisted = hits2.filter((h) => JSON.stringify(h).includes(MARKER)).length;
  rec("restart-persistence", { warm_start_ms: warmStartMs, search_ms: search2Ms,
    hits: hits2.length, marker_hits: persisted, persisted: persisted > 0 });

  // ---- 5. structured errors ----
  const errs = {};
  try { await c2.request("teleport", {}); } catch (e) { errs.unknown_op = e.code; }
  try { await c2.request("add", { dataset: DATASET }); } catch (e) { errs.bad_params = e.code; }
  try { await c2.request("cognify", { datasets: ["c2_does_not_exist"] }, { timeoutMs: 60_000 }); }
  catch (e) { errs.missing_dataset = e.code; errs.missing_dataset_msg = String(e.message).slice(0, 120); }
  c2.child.stdin.write("this is not json\n");
  await new Promise((r) => setTimeout(r, 1500));
  rec("structured-errors", errs);
  const c2s = await c2.shutdown(); // release locks before the kill scenario
  rec("second-shutdown", { ms: c2s, exit: c2.exited });

  // ---- 6. killed worker: outcome-unknown, no auto-retry ----
  let c3 = new WorkerClient("kill");
  await c3.start();
  const killTarget = `${MARKER}-INTERRUPTED-WRITE payload for kill test`;
  const inflight = c3.request("add", { dataset: DATASET, text: killTarget }, { mutating: true })
    .then(() => ({ resolved: "completed-before-kill" }))
    .catch((e) => ({ resolved: "rejected", code: e.code, outcome: e.outcome }));
  await new Promise((r) => setTimeout(r, 120)); // kill while add in flight
  await c3.kill();
  const fate = await inflight;
  rec("killed-worker", { ...fate, exit: c3.exited,
    semantics: "mutating op reported outcome=unknown; NO automatic retry" });

  // restart + read-back reconciliation (reported, not retried)
  let c4 = new WorkerClient("post-kill");
  await c4.start();
  const rb = await searchChunks(c4, "INTERRUPTED-WRITE");
  const landed = rb.some((h) => JSON.stringify(h).includes("INTERRUPTED-WRITE"));
  rec("post-kill-reconciliation", { read_back_hits: rb.length, write_landed: landed,
    note: "reconciliation by read-back only; the interrupted write itself was never retried" });
  const statusAfter = await c4.request("status");
  rec("memory-post-kill", statusAfter);
  const sMs = await c4.shutdown();
  rec("final-shutdown", { ms: sMs });

  writeFileSync(path.join(ROOT, "worker", "demo-results.json"), JSON.stringify(results, null, 2));
  console.log("\nDEMO COMPLETE -> worker/demo-results.json");
}

main().catch((e) => { console.error("DEMO FAILED:", e); process.exit(1); });
