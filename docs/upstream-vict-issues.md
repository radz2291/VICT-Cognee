# Upstream VICT issues observed by the Cognee pack work (read-only reference)

Repo: radz2291/VICT-Cognee. Reference VICT commit (read-only, never modified):
radz2291/vict-02 @ **`5ea0afe257d5e7f67e050fcae169746a25fd3cc4`**
("fix(stage8-p1)", 2026-09-25). All line references below were verified against
both `packages/*/src` and the committed `packages/*/dist` at that commit.

These issues are documented here, upstream, **without editing VICT**. The pack
works around both at its own boundary (fail-closed); neither workaround claims
to fix VICT.

---

## UV-1 — Durable orchestration engine ignores `decision.useDouble`: real bindings run in `test`/`simulate`

**Severity: safety (pack-relevant).** The effect-policy table
(`packages/runtime/src/effect-policy.ts`, "Night 01" table) promises that in
`simulate`/`test` modes the real implementations of `read`, `write`, and
`irreversible` effects are *unreachable* — a registered double must run, and
without one the operation is blocked.

The **sequential engine** honors this (`packages/runtime/src/runtime.ts`
~1336–1400: `useDouble` selects the registered double, and an unregistered
double is turned into a blocked decision).

The **durable orchestration driver** does not
(`packages/runtime/src/orchestration-driver.ts`, `#executeAttempt`, ~line 702):

```ts
if (decision.useDouble) {
  // Doubles are a Stage 02 sequential-engine facility; the durable
  // orchestration engine always runs the pinned real binding.
  // (Test doubles for orchestration runs are provided as capabilities.)
}
```

The decision is computed, acknowledged in a comment, and then discarded —
`binding.invoke(...)` (~line 778) runs the **pinned real binding** in every
mode. Only the irreversible *denial* (`decision.allowed === false`) is
enforced on this path. Consequences for any capability pack whose real
bindings have external effects (file stores, databases, workers):

- A graph author who tests a durable graph in `test`/`simulate` mode —
  expecting the documented double/block isolation — actually executes real
  effects.
- A pack's test/simulate doubles are dead code on durable graphs; read
  capabilities with no double, which the sequential engine blocks
  (`effect.blocked`), run their real implementation on the durable engine.

**Graph-engine selection makes this reachable by accident:** any node with
`retry` or `timeoutMs`, any control node (`decision`/`fork`/`join`/`wait`), or
any non-success edge flips the graph to the durable engine
(`packages/kernel/src/canonical.ts:185-201` `declaresControlSemantics`;
`kernel/src/compile.ts:1189`; `runtime.ts:869` — compile to
`vict.activation@2`). A durable graph is therefore the *common* case, not the
edge case.

**Pack mitigation (this repo):** every real Cognee binding fails closed unless
`ctx.mode === 'normal'` (`pack/src/bindings.ts`) — the durable engine can no
longer reach the worker/store in `test`/`simulate`. This restores the
documented policy table at the pack boundary; VICT-side durable graphs
involving *other* packs remain affected.

**Suggested upstream fix:** either honor `decision.useDouble` on the durable
path (require a registered double eligible in the run mode) or block durable
non-`normal`-mode invocations of non-`pure` capabilities with a structured
`effect.blocked` outcome — and document which engine owns mode isolation in
the effect-policy table.

---

## UV-2 — `deriveIdempotencyKey` accepts `invocationId` but never includes it in the key

`packages/runtime/src/orchestration-activation.ts:226-242`:

```ts
export function deriveIdempotencyKey(parts: {
  runId: string;
  activationVersion: string;
  lineage: string;
  nodeId: string;
  invocationId: string;   // <-- accepted in the signature
}): string {
  return `idem_${sha256Hex(
    toCanonicalJson({
      activationVersion: parts.activationVersion,
      lineage: parts.lineage,
      nodeId: parts.nodeId,
      runId: parts.runId,
      schema: 'vict.idempotency-key@1',
      // invocationId is MISSING from the hashed payload
    }),
  ).slice(0, 32)}`;
}
```

The sole durable-driver call site
(`orchestration-driver.ts:405-412`) derives `invocationId` and passes it in —
the parameter is silently dropped from the hash.

**Why it does not collide today (verified):** `deriveInvocationId`
(`orchestration-activation.ts:245-260`) is itself a deterministic function of
exactly `{runId, activationVersion, lineage, nodeId}` — the same fields the
key already hashes. Graphs are compile-time acyclic
(`kernel/src/compile.ts:1067-1079` rejects cycles), token lineage is
path-derived (`canonicalBranchLineage`/`forkLineageOf`,
`orchestration-plan.ts:308,348`), and `attemptNumber` is derived per
invocationId (`orchestration-in-memory.ts:283-286`). So within current VICT
there is no path to two *distinct logical invocations* sharing the full key
tuple; the omission is redundancy, not collision.

**Why it is still a defect (latent):** the function's contract — its signature
— promises that the key participates in `invocationId`. If a future VICT
changes invocation identity (e.g., a per-visit counter, an epoch, or
re-invocation semantics for repeated work), the idempotency key would
silently keep its current derivation and **reuse a previous logical
invocation's key for genuinely new work**. Downstream keyed stores (like this
pack's durable journal) would then either replay a stale outcome for new
identical input or — with input binding, as implemented here — fail closed
with `COGNEE_IDEMPOTENCY_MISMATCH` for changed input. Both are wrong for the
caller; the second is at least loud.

**Pack mitigation (this repo):** the pack binds every journal key durably to
`(op, dataset, input fingerprint)` (`docs/c3-pack-contract.md` §7.3), so a
colliding key reuse for different logical work is rejected, never silently
replayed. The residual risk (identical-input re-invocation replaying a stale
outcome instead of re-executing) is stated in §7.3 and is unreachable within
the pinned VICT (`^0.1.0`, acyclic graphs, deterministic invocation ids).

**Suggested upstream fix:** include `invocationId` in the hashed payload and
bump the schema tag (`'vict.idempotency-key@2'`), or remove it from the
signature so the contract matches the implementation.

---

## Verification notes

- Fact lines were read at `5ea0afe257d5e7f67e050fcae169746a25fd3cc4` in the
  local clone `/260831-VCT-02` (working tree clean, only `.pi/` untracked) and
  cross-checked against the committed `dist/` bundles the pack imports.
- Observed pack-side consequences are recorded in
  `pack/verify/verify.ts` (ABI OBSERVATION record) and
  `docs/c3-pack-contract.md` §1.