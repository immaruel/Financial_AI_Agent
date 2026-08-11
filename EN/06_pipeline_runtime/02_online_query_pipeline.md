# 02. Online Query Pipeline

## 1. Purpose

The online pipeline is the real-time path executed when a user query arrives. It handles the flow of query understanding → retrieval-policy decision → parallel per-channel retrieval → evidence verification → claim generation/verification → answer gating, with recovery attempted only within a bounded retry budget. Real-time supplemental collection runs at most once, and only as a last resort when the KG/corpus is judged to lack the information itself.

From a harness engineering perspective, the goals of the online pipeline are:

- handle most queries **stably without human intervention**
- automatically detect **missing evidence, temporal errors, and risky phrasing**
- respond to failure in the order **self-repair → safe fallback → human escalation**

---

## 2. Execution Flow

The entry point is `FinancialKGPipeline.query(user_query, tenant_id, user_id, request_timestamp, assurance_mode) -> Dict`, and the actual processing is handled by `AgentOrchestrator.process_request()` (`agent/orchestrator.py`).

```text
Query Understanding Agent (LLM structured output)
        ↓ schema/entity/time validation (deterministic)
Retrieval Policy Builder (deterministic)
        ↓
Only the memory / graph / hybrid (lexical+vector) / document-block workers
selected by the policy run, in parallel
        ↓
Evidence Fusion (RRF) + Rerank
        ↓
Evidence Requirement Gate (pre-check on evidence modality)
        ↓
Claim-first Generator (LLM, constrained to evidence IDs)
        ↓
Deterministic Claim Verifier (entailment/numeric/temporal/attribution/relation/locator)
        ↓
Answer Gate
  ├─ pass                    → Answer Renderer → Risk/Harness post-check → final answer
  ├─ repair                  → Critic → Supervisor → bounded retry/replan → (back to the loop above)
  └─ abstain / clarification → surface uncertainty or ask a follow-up question
        ↓
Record CitationLedger → PipelineHarness.evaluate_online_query() → StructuredAnswer
```

Retries are never triggered merely by "there was no result." They rely on structured failure codes — `TOOL_TIMEOUT`, `ENTITY_UNRESOLVED`, `RETRIEVAL_EMPTY`, `INSUFFICIENT_PRIMARY_EVIDENCE`, `NUMERIC_MISMATCH` — together with a retry budget scoped to `(worker, input_hash, failure_code)`. Each component's detail is described in the following documents.

- [04_agent_system/01_agent_architecture.md](../04_agent_system/01_agent_architecture.md) — full execution loop and component table
- [04_agent_system/02_query_understanding_and_routing.md](../04_agent_system/02_query_understanding_and_routing.md) — Query Understanding, Retrieval Policy
- [04_agent_system/03_retrieval_workers.md](../04_agent_system/03_retrieval_workers.md) — Graph/Hybrid/Document-block workers
- [04_agent_system/04_evidence_and_claims.md](../04_agent_system/04_evidence_and_claims.md) — Evidence Requirement Gate, Claim-first Generator
- [04_agent_system/05_verification_and_answer_gate.md](../04_agent_system/05_verification_and_answer_gate.md) — Claim Verifier, Answer Gate
- [04_agent_system/06_recovery_memory_and_harness.md](../04_agent_system/06_recovery_memory_and_harness.md) — Critic/Supervisor, user memory, risk management

---

## 3. The Role of `FinancialKGPipeline.query()`

```python
def query(self, user_query, *, tenant_id="default", user_id="anonymous",
          request_timestamp=None, assurance_mode="high_assurance") -> Dict:
    agent_run = self.agent_orchestrator.process_query_with_trace(
        user_query, tenant_id=tenant_id, user_id=user_id,
        request_timestamp=request_timestamp, assurance_mode=assurance_mode,
    )
    online_run = self.harness.evaluate_online_query(user_query, agent_run, attempt=0, recovery_action="primary")
    answer = online_run["answer"]

    if (
        answer.status == "abstained"
        and retryable_retrieval_failure   # RETRIEVAL_EMPTY / INSUFFICIENT_PRIMARY_EVIDENCE and retryable
        and self.config.harness.enable_online_supplement
        and online_sources_configured
    ):
        await self._online_supplement(user_query)   # small real-time collection by query keyword, merged into the existing KG
        self.step4_init_agents()                     # reinitialize entity_dict/agent
        agent_run = self.agent_orchestrator.process_query_with_trace(...)  # second attempt
        online_run = self.harness.evaluate_online_query(user_query, agent_run, attempt=1, recovery_action="online_supplement")

    payload = answer.model_dump(mode="json")
    payload["harness"] = {
        "run_id": online_run["run_id"], "verification": online_run["verification"],
        "failure_cases": online_run["failure_cases"], "gate_status": online_run["gate_status"], ...
    }
    return payload
```

The key point is that `_online_supplement` does **not** respond to every retrieval failure. Only when the `AgentOrchestrator`'s internal Critic/Supervisor loop has already tried every allowed channel/period/synonym expansion and the answer is still `abstained`, with the cause narrowed to "the KG/corpus simply has no relevant information," does the system consider external real-time collection. Treating every retrieval failure as a reason to collect externally would sharply increase latency, cost, and reproducibility risk.

### 3.1 Real-time Supplemental Collection (`_online_supplement`)

```text
1. Extract keywords from the query (Korean/English tokens of 2+ characters, up to 3)
2. Small-batch collection: up to 20 Naver News articles + DART filings
3. Normalize -> canonicalize -> preprocess -> build a GraphPayload
4. Merge into the existing graph_store (replace=False) only if harness.validate_graph_payload() passes
5. On failure, abort the merge and only log a warning (never leaves a partially
   contaminated KG)
```

---

## 4. Worker Contract

Every worker returns `WorkerResult(worker, status, output_ids, failure, metadata)`. `status` is one of `SUCCESS`/`PARTIAL`/`FAILED`/`SKIPPED`; an empty result list is never treated as success.

| Worker | Input | Output | Success condition | Representative failure codes |
|---|---|---|---|---|
| `graph_retrieval` | `QuerySpec`, `RetrievalPolicy` | `GraphWorkerOutput` (evidence, paths, subgraph) | Both a seed and admissible evidence are secured | `ENTITY_UNRESOLVED`, `RETRIEVAL_EMPTY`, `INSUFFICIENT_PRIMARY_EVIDENCE` |
| `hybrid_retrieval` | `QuerySpec`, `RetrievalPolicy` | `HybridWorkerOutput` (evidence, hits) | Fused lexical/vector results secured | `RETRIEVAL_EMPTY`, `RETRIEVAL_DEGRADED`, `MODEL_FALLBACK` |
| `document_block_retrieval` | Same (tables/figures only) | Same | Table/figure evidence secured | Same |
| Memory selection | `QuerySpec` | `MemorySelection` | Relevant memory selected, if any | `memory_worker_failed:*` |

---

## 5. Constraint Layer

| Rule | Description |
|------|-------------|
| No unsupported freshness claims | Evidence published after `as_of` is never admissible, and "recent/current" is never asserted without support |
| No claim generation without retrieval/evidence verification | The Claim Generator is only called once the Evidence Requirement Gate returns `pass` |
| Speculative statements are restricted | Causal wording is allowed only when the evidence has a `causal=True` edge or an explicit causal marker |
| High-risk financial advice is prohibited | Buy/sell recommendations, profit guarantees, and definitive forecasts are prohibited — enforced twice, in the claim-generation prompt and in the harness advice-risk check |
| Retry budget is limited | Self-repair is bounded by `RetrievalPolicy.retry_budget` and `Supervisor.max_same_failure_retries` |

---

## 6. Verification Layer Summary

Claim-level verification (coverage/entailment/numeric/temporal/attribution) is detailed in [04_agent_system/05_verification_and_answer_gate.md](../04_agent_system/05_verification_and_answer_gate.md). This section summarizes only the online-execution perspective.

| Layer | Verification items |
|---|---|
| Planner/Policy | Intent/entity/temporal accuracy, evidence_needs judgment accuracy, channel-selection accuracy |
| Evidence | Evidence recall@k/precision@k, citation coverage, whether contradictions were included, locator validity |
| Claim/Answer | Numeric/temporal/attribution accuracy, unsupported claim rate, causal overclaim rate, advice risk score |

Recommended operational rules:

- Every core claim needs at least one direct piece of evidence (Evidence Requirement Gate + Answer Gate)
- When contradicting evidence exists, never arbitrarily pick a side — show it alongside (the `conflicts` field) or abstain
- A causal claim is stated definitively only when both a `causal=True` graph edge and source-text support are present
- A low-confidence answer explicitly carries `confidence`/`risk_warnings`

---

## 7. Feedback Loop Layer

### 7.1 Recovery Priority

The Critic/Supervisor's diagnosis order and action mapping are described in [04_agent_system/06_recovery_memory_and_harness.md §1](../04_agent_system/06_recovery_memory_and_harness.md). Summary:

```text
1. Entity ambiguous/unresolved (before any worker ran) → clarification
2. Graph-related failure → retry graph
3. Numeric/table/temporal/attribution-related failure → retry document-block
4. Missing primary-source quote / insufficient citation → retry hybrid (synonym expansion)
5. Any other claim failure → remove that claim and re-verify
6. Conflicting evidence → abstain, never pick arbitrarily
7. Retry budget exhausted, or the question itself is ambiguous → abstain / clarification /
   (only if there is genuinely no underlying information) one round of real-time
   supplemental collection followed by a retry
```

### 7.2 Linking to the Failure Taxonomy

Online failures are tagged with one or more of F1 (entity confusion), F2 (temporal error), F3 (numeric error), F4 (attribution error), F5 (missing evidence), F6 (overstated reasoning), F7 (safety error), F8 (over-defensiveness). This classification is what lets a retrieval bottleneck be separated from a reasoning bottleneck.

---

## 8. Trace / Observability

The `CitationLedger` (an immutable, per-session record) and the trace files produced by `PipelineHarness` are detailed in [04_agent_system/01_agent_architecture.md §10](../04_agent_system/01_agent_architecture.md). Every online execution writes the following under `online_registry_dir`.

- `query_trace.json`, `retrieval_trace.json`, `evidence_trace.json`, `reasoning_trace.json`, `answer_trace.json`
- `verification.json`, `orchestration_trace.json` (a summary of query_spec/policy/worker_results/claims/verdicts/ledger), `run_record.json`
- `failure_cases.json` when there is a failure

Without this trace, the system can only tell you "the answer was wrong," not "why it was wrong."

---

## 9. Human-in-the-Loop Design

Human intervention occurs only under the following conditions.

| Condition | Example |
|-----------|---------|
| high-risk decision | Investment-advice-like queries, regulatory/legal interpretation, sensitive market forecasts |
| low-confidence output | Entity ambiguity, evidence insufficiency, temporal uncertainty |
| system failure | Repeated self-repair failure, or evidence still insufficient even after real-time supplemental collection |

When `answer.human_review_required = True`, a `review_ticket` (run_id, risk_class, failure_codes, trace_paths, recommended_action) is attached to the answer.

---

## 10. Where the LLM Is Used

| Point | Used? | Notes |
|------|-----------|------------------|
| Query Understanding Agent | Yes | Produces the QuerySpecDraft; one repair pass on failure, then a deterministic fallback |
| Claim-first Generator | Yes | Produces atomic claims constrained to evidence IDs; one repair pass on failure, then a deterministic fallback (verbatim extraction) |
| Retrieval Policy Builder, Deterministic Claim Verifier, Answer Gate, Critic, Supervisor | No | All rule/code based |
| Retrieval (BM25/BGE-M3/graph traversal/RRF/rerank) | No (dedicated retrieval models) | On model load failure, an explicit deterministic fallback is used and labeled as such |

Core principles:

- The LLM never drives the answer without retrieval and evidence (the Evidence Requirement Gate runs first)
- LLM output always passes through the verification layer
- Safety concerns get one more independent check from the harness's post-hoc verification

---

## 11. CI/CD Gate and Operational Metrics

The pre-deployment gate for the online pipeline prioritizes these metrics.

- Accuracy
- Faithfulness
- Consistency
- Latency
- Cost
- Safety / Compliance

Concrete metric examples:

- `factual_accuracy`, `evidence_grounding_score`, `temporal_accuracy`
- `unsupported_claim_rate`, `citation_coverage`
- `latency_p95`, `token_cost_per_query`
- `compliance_pass_rate` (share with no advice-risk detected)

Hard-gate examples: a spike in unsupported claims, worsening advice risk score, a sharp drop in temporal consistency.
Soft-gate examples: rising latency, rising cost, a small drop in conciseness/readability.

---

## 12. Design Rationale

**Why not repeat self-repair indefinitely?**
There is no guarantee that real-time supplemental collection will always surface relevant information. Unlimited retries would sharply increase response latency and cost. After a set number of attempts, safe failure or human review is preferable.

**Why must contradicting evidence be considered together?**
Financial events often carry conflicting interpretations of the same incident. A system that only looks at supporting evidence tends to produce plausible-sounding but risky answers.

**Why is online trace important?**
Being able to separate a retrieval problem from a reasoning problem or an answer-composition problem is what makes improvement fast. A system without trace can detect a regression but struggles to pinpoint its cause.

**Why is real-time supplemental collection kept as a last resort?**
If the Critic/Supervisor has already tried every allowed retrieval channel, period, and phrasing and evidence is still missing, the problem is more likely a gap in the KG/corpus itself than a retrieval-strategy issue. Paying the cost of external collection only in that case is the order of operations that expands coverage while preserving latency and reproducibility.
