# 01. Agent System Architecture

## 1. Purpose

Define the agent layer that accepts a user's natural-language query, selects and runs retrieval channels in parallel based on the evidence the question requires, verifies claims one by one, and diagnoses and recovers from failures — a verifiable multi-agent orchestration.

This document does more than list the agents in the system. From a harness engineering perspective, it also defines:

- Each agent/worker's input and output contract
- Success and failure conditions
- Verification points inside the execution loop
- Trace/ledger collection format
- Self-repair and human-escalation criteria

---

## 2. What Counts as an "Agent," and the Design Principles

`AgentOrchestrator` (`agent/orchestrator.py`) is not a fixed pipeline that calls several classes in the same order every time. It only qualifies as multi-agent orchestration because it satisfies all five conditions below.

1. **The worker set changes based on the planner's result** — a worker not listed in `RetrievalPolicy.channels` is never executed.
2. **Independent workers and verifiers run in parallel** — the memory/graph/hybrid/document-block workers run concurrently via a `ThreadPoolExecutor`, and the claim verifier's four verification axes (entailment/numeric/temporal/attribution) are also computed together per evidence pair.
3. **Each worker has different tool permissions and result schemas** — the graph worker only performs graph traversal within a confidence threshold; the hybrid worker only performs BM25/dense search; neither touches the other's resources.
4. **A Supervisor chooses retry, an alternate path, or termination based on failure state** — this is handled by `CriticAgent.diagnose()` → `Supervisor.authorize()`.
5. **Every decision and tool call can be reproduced from trace** — the `CitationLedger` keeps an immutable record per session.

"Agent" does not simply mean an LLM call. It is a role that carries at least one of: an independent input/output contract, restricted tool permissions, explicit success/failure state, or dynamic routing. Conversely, reproducible search such as BM25/RRF/graph traversal is kept as a deterministic worker.

---

## 3. Logical Components

| Component | Class / module | Role | Uses an LLM |
|-----------|-----------------|------|---|
| Query Understanding Agent | `QueryUnderstandingAgent` (`agent/query_understanding.py`) | Natural-language query → `QuerySpecDraft` → deterministically validated `QuerySpec` | Yes |
| Retrieval Policy Builder | `RetrievalPolicyBuilder` (`agent/routing.py`) | `QuerySpec` → `RetrievalPolicy` (channels/budget/retry) | No |
| Graph Retrieval Worker | `GraphRetrievalWorker` (`retrieval/graph.py`) | Seed discovery → subgraph → paths → EvidenceBlock expansion | No |
| Hybrid / Document-block Retrieval Worker | `HybridRetrievalWorker` (`retrieval/hybrid.py`) | BM25 + BGE-M3 lexical/vector search; with `document_blocks_only=True`, tables/figures only | No |
| Evidence Fusion & Rerank | `fuse_ranked_evidence` + `Reranker` (`retrieval/hybrid.py`) | Fuse per-channel ranks with RRF and re-order with a cross-encoder | No (the cross-encoder is a dedicated retrieval model) |
| User Memory Store | `UserMemoryStore` (`agent/memory.py`) | Select tenant/user-scoped personalization memory with deterministic rules | No |
| Context Builder | `ContextBuilder` (`agent/context_builder.py`) | Assemble QuerySpec/evidence/graph paths/memory into an evidence-ID-allowlisted context | No |
| Evidence Requirement Gate | `EvidenceRequirementGate` (`agent/requirements.py`) | Block generation upfront unless every `required` evidence modality is satisfied | No |
| Claim-first Generator | `ClaimFirstGenerator` (`agent/generation.py`) | Context → atomic claims constrained to evidence IDs | Yes |
| Deterministic Claim Verifier | `DeterministicClaimVerifier` (`agent/verification.py`) | Per claim-evidence pair: entailment/numeric/temporal/attribution/relation/locator verification | No |
| Answer Gate | `AnswerGate` (`agent/verification.py`) | Claim verdicts → pass/repair/abstain | No |
| Critic | `CriticAgent` (`agent/supervisor.py`) | Gate reason codes + worker failures → `RecoveryDecision` | No |
| Supervisor | `Supervisor` (`agent/supervisor.py`) | Approve only allowed recovery actions; cap retries for the same failure | No |

`AgentOrchestrator` assembles these components and directly handles the logic not covered by the table above (answer rendering, ledger recording, trace computation).

---

## 4. Full Execution Flow

```text
User query + tenant_id + user_id + request_timestamp
        │
        ▼
[1] QueryUnderstandingAgent.understand()
        │  QuerySpec (validation_status: valid / entity_ambiguous / planner_fallback)
        ▼
[2] RetrievalPolicyBuilder.build()
        │  RetrievalPolicy (channels, source_filters, date_filter, evidence_budget, retry_budget)
        ▼
[3] Parallel execution (ThreadPoolExecutor)
        │  ├─ UserMemoryStore.select()            (memory_mode != off)
        │  ├─ GraphRetrievalWorker.run()           ("graph" in channels)
        │  ├─ HybridRetrievalWorker.run()          ("lexical"/"vector" in channels)
        │  └─ HybridRetrievalWorker.run(document_blocks_only=True)  ("document_block" in channels)
        ▼
[4] fuse_ranked_evidence() (RRF) → Reranker.rerank() → prioritize_relative_order()
        │  List[EvidenceBlock]
        ▼
[5] EvidenceRequirementGate.evaluate()
        │  if not "pass", skip straight to [8] (retry/terminate without generation)
        ▼
[6] ContextBuilder.build() → ClaimFirstGenerator.generate()
        │  List[AtomicClaim]
        ▼
[7] VerificationPipeline.verify_and_gate()
        │  = DeterministicClaimVerifier.verify() + AnswerGate.evaluate()
        │  AnswerGateDecision (pass / repair / abstain / clarification)
        ▼
[8] gate.decision == pass?
        ├─ yes → _render_answer() → StructuredAnswer
        └─ no  → CriticAgent.diagnose() → Supervisor.authorize()
                      │  RecoveryDecision.next_actions
                      ▼
                _run_recovery_worker() (retry graph / retry document-block /
                      retry hybrid with expanded terms / remove claim) → back to [4]
                if the same (worker, input_hash, failure_code) exceeds the retry
                      limit, abstain
        ▼
Record CitationLedger → return StructuredAnswer
```

`process_request()` in `agent/orchestrator.py` runs this entire loop.

```python
class AgentOrchestrator:
    def __init__(self, config, graph_store, llm_client=None, entity_dict=None, memory_store=None):
        self.query_understanding = QueryUnderstandingAgent(llm_client, entity_dict or {})
        self.policy_builder = RetrievalPolicyBuilder(config.retrieval, config.supervisor)
        self.memory_store = memory_store or UserMemoryStore(config.memory, ...)
        self.context_builder = ContextBuilder(config.context)
        self.claim_generator = ClaimFirstGenerator(llm_client, config.audit)
        self.requirement_gate = EvidenceRequirementGate()
        self.verification = VerificationPipeline(config.verification)
        self.critic = CriticAgent()
        self.supervisor = Supervisor(config.supervisor)

    def process_request(self, request: QueryRequest) -> AgentRunResult:
        spec = self.query_understanding.understand(request)
        policy = self.policy_builder.build(spec, request.assurance_mode)
        memory_selection, worker_outputs, tool_calls = self._run_initial_workers(spec, policy, ...)
        evidence, _ = self._fuse_and_rerank(spec.original_query, [...], policy, catalog)
        while True:
            gate = self.requirement_gate.evaluate(spec, evidence, graph_output.paths, worker_results)
            if gate.decision == "pass":
                context = self.context_builder.build(spec, policy, evidence, ...)
                claims, _ = self.claim_generator.generate(spec, context, evidence)
                verdicts, gate = self.verification.verify_and_gate(claims, evidence, as_of=spec.as_of, query_spec=spec)
                if gate.decision == "pass":
                    break
            decision = self.supervisor.authorize(self.critic.diagnose(gate, worker_results, retries_remaining))
            if decision.decision in {"abstain", "clarification"}:
                break
            # run_graph_retrieval / run_document_block_retrieval / run_hybrid_text_retrieval / remove_claim
            output, trace = self._run_recovery_worker(decision.next_actions[0], spec, policy, catalog, graph_worker)
            ...
        return AgentRunResult(answer=self._render_answer(...), ledger=ledger, ...)
```

---

## 5. Mapping to Perceive → Plan → Act → Observe → Reflect → Iterate

| Stage | Actual implementation | Input | Output | Failure handling |
|-------|------------------------|-------|--------|-------------------|
| Perceive | Build `QueryRequest`; preflight checks for entity-ambiguous / unresolved graph-required entities | raw query, tenant/user, request_timestamp | `QueryRequest` | An unresolved required entity ends the run as `clarification` before any worker runs |
| Plan | `QueryUnderstandingAgent` + `RetrievalPolicyBuilder` | normalized query | `QuerySpec`, `RetrievalPolicy` | On schema validation failure, one repair attempt; if that also fails, a deterministic fallback draft |
| Act | Parallel worker execution + fusion/rerank + claim generation | `QuerySpec`, `RetrievalPolicy` | `WorkerResult`, `EvidenceBlock`, `AtomicClaim` | Each worker records its failure code (`TOOL_TIMEOUT`, `RETRIEVAL_EMPTY`, `ENTITY_UNRESOLVED`, etc.) in its result contract |
| Observe | `EvidenceRequirementGate` + `VerificationPipeline` | evidence, claims | `AnswerGateDecision`, `ClaimVerdict` | Coverage/numeric/temporal/attribution mismatches are structured as reason codes |
| Reflect | `CriticAgent.diagnose()` | gate, worker_results, retries_remaining | `RecoveryDecision` | Retry eligibility and the alternate channel are decided by code rules |
| Iterate | `Supervisor.authorize()` + `_run_recovery_worker()` | recovery decision | corrected answer / abstain / clarification | Once the same `(worker, input_hash, failure_code)` exceeds its retry limit, the run terminates safely |

---

## 6. Constraint Layer

The agent layer enforces the following boundaries.

| Rule | Where it is implemented |
|------|--------------------------|
| The Query Understanding Agent never produces tool names or canonical entity IDs directly | `QueryUnderstandingAgent` extracts only surface forms; `DeterministicEntityResolver` finalizes them |
| `evidence_needs` is not boolean — it is `required`/`preferred`/`not_needed`, and code corrects it when it conflicts with explicit query keywords | `QuerySpecValidator._validated_needs()` |
| The Graph Retrieval Worker only traverses within allowed edge types and hop limits | `GraphRetrievalWorker._edge_types()`, `min_edge_confidence` |
| Retrieval Policy is decided only by code; the LLM never selects channels directly | `RetrievalPolicyBuilder.build()` |
| The Claim Generator cannot cite an evidence ID absent from the context | Allowlist validation + repair in `ClaimFirstGenerator.generate()` |
| No unsupported causal assertions — `PRECEDES`/`POSSIBLY_RELATED_AFTER` are never promoted to causation | `CLAIM_SYSTEM_PROMPT` rules + the verifier's `_relation_semantics()` |
| A claim that fails the Answer Gate never appears in the final answer | `_render_answer()` only uses `gate.accepted_claim_ids` |
| Retry budget is governed by policy and the Supervisor; unlimited retries are never allowed | `RetrievalPolicy.retry_budget`, `Supervisor.register_failure()` |

Additional finance-domain constraints:

- Sentences that directly recommend an investment decision are prohibited; over-confident wording ("certain," "guaranteed," "definitely") is suppressed
- When freshness cannot be confirmed, the response states `as_of` explicitly and uses conservative phrasing
- When entity-resolution ambiguity is high, the system stops with `clarification` instead of asserting a specific entity

---

## 7. Context Layer

Information the agent must always consult is managed as structured context assets.

| Asset | Role | Implementation |
|-------|------|-----------------|
| ontology / schema snapshot | Event types, entity types, edge constraints | `ontology/`, `utils/schemas.py` |
| prompt bundle version | Version management for query interpretation and claim-generation prompts | `AuditConfig.query_prompt_version`, `claim_prompt_version` |
| retrieval/index snapshot | Reproducible-search evidence corpus version | `EvidenceCatalog.snapshot_id` |
| failure taxonomy | F1–F8 error classification | [00_overview.md §9](../00_overview.md) |
| risk policy | Prohibited phrases, low-confidence handling rules | `harness/runtime.py`'s advice-risk check, the fixed warnings in `_render_answer()` |

---

## 8. Verification Layer

| Verification item | Where it is implemented |
|--------------------|---------------------------|
| QuerySpec schema / entity / time validity | `QuerySpecValidator` |
| Evidence Requirement Gate (pre-generation) | `EvidenceRequirementGate.evaluate()` |
| Claim-evidence entailment | `DeterministicClaimVerifier.verify_pair()` (`entailment`) |
| Numeric/unit/currency/period agreement | `DeterministicClaimVerifier._verify_numeric()` |
| Consistency with the stated as-of time | `DeterministicClaimVerifier._verify_temporal()` |
| Speaker/company/document attribution | `DeterministicClaimVerifier._verify_attribution()` |
| Relation direction / prevention of overstated causation | `_relation_semantics()` |
| Citation coverage threshold, critical-claim blocking | `AnswerGate.evaluate()` |

Core principle: when both valid supporting and valid contradicting evidence exist, a claim becomes `conflict` — the system never arbitrarily picks one side in the final answer; it either surfaces both or abstains.

---

## 9. Feedback Loop Layer

### 9.1 Failure Signal → Recovery Action

| Failure signal | Critic verdict | Action once approved by the Supervisor |
|---|---|---|
| Graph worker failed / required relationship evidence missing | `REQUIRED_GRAPH_WORKER_FAILED`, `REQUIRED_GRAPH_EVIDENCE_MISSING` | `run_graph_retrieval` |
| Numeric/table/figure evidence missing, document worker failed | `REQUIRED_NUMERIC_EVIDENCE_MISSING`, `NUMERIC_MISMATCH`, `LOCATOR_MISSING`, etc. | `run_document_block_retrieval` |
| Primary-source-quote evidence missing, hybrid worker failed, low citation coverage | `REQUIRED_PRIMARY_SOURCE_QUOTE_MISSING`, `INSUFFICIENT_PRIMARY_EVIDENCE`, `CITATION_COVERAGE_LOW` | `run_hybrid_text_retrieval` (including synonym expansion) |
| A claim failure not covered above | Other claim failure | `remove_claim` |
| Entity ambiguous, before any worker ran | `ENTITY_AMBIGUOUS`/`ENTITY_UNRESOLVED` | `ask_clarification` |
| Conflicting evidence found | `evidence_conflict` | `abstain` (never pick a side arbitrarily) |
| `retries_remaining <= 0` | `RETRY_BUDGET_EXHAUSTED` | `abstain` |

The Supervisor automatically downgrades any action not present in `config.supervisor.allowed_recovery_actions` to `abstain`, and once a `(worker, input_hash, failure_code)` combination exceeds `max_same_failure_retries`, it stops retrying for that same cause.

### 9.2 Linking to the Failure Taxonomy

Both recovery diagnoses and the harness's post-hoc checks are tagged with the F1–F8 codes from [00_overview.md §9](../00_overview.md). This classification is what makes it possible to separate a retrieval bottleneck from a reasoning bottleneck.

---

## 10. Trace / Observability

`AgentRunResult` (from the orchestrator) and `PipelineHarness.evaluate_online_query()` (`harness/runtime.py`) together produce the following trace.

### 10.1 CitationLedger (immutable, per session)

- `query_id`, `request_timestamp`, tenant/user scope hash
- `query_spec`, `retrieval_policy`, `memory_selection` (only hashes are recorded; raw content is never persisted)
- `tool_calls`: worker/selected_by/status/latency/output_ids/backend/snapshot_id
- `llm_calls`: stage/model/prompt_version/temperature/input_hash/output_hash/status
- `claim_evidence_mapping`, `claim_text_hashes`, `claim_verdicts`
- `gate_history`, `recovery_history`
- `final_answer_hash`, `config_hash`

The ledger file is written once per session under `config.audit.ledger_dir`, in a mode that cannot overwrite an existing file (opened with `"x"`).

### 10.2 Harness trace files

`harness/runtime.py` writes the following files under `online_registry_dir` for every online query execution.

- `query_trace.json` — raw/normalized query, planner confidence, risk class
- `retrieval_trace.json` — seed/retrieved node and edge IDs, pruning statistics, retrieval mode
- `evidence_trace.json` — selected evidence IDs per event, ranking signal, whether contradictions were included
- `reasoning_trace.json` — generated / accepted / rejected hypotheses
- `answer_trace.json` — final answer, cited evidence IDs, risk flags, latency
- `verification.json`, `orchestration_trace.json` (a summary of query_spec/policy/worker_results/claims/verdicts/ledger), `run_record.json`

Without this trace, the system can only tell you "the answer was wrong," not "why it was wrong" or whether the bottleneck was retrieval or reasoning.

---

## 11. Human-in-the-Loop

Human intervention is requested only under these conditions.

- high-risk decision
- low-confidence output
- repeated system failure

Concrete triggers:

- High entity ambiguity that directly affects the core answer (`clarification` status — the user is asked again first; this is not `human_review_required`)
- The Answer Gate ends in `abstain` (`human_review_required = True`)
- `PipelineHarness` detects advice-risk keywords above the threshold (F7)
- Answer confidence is below `human_review_confidence_threshold`
- The Supervisor's retry budget is exhausted

When `human_review_required = True`, `harness/runtime.py` attaches a `review_ticket` (run_id, risk_class, failure_codes, trace_paths) to the answer.

---

## 12. Related Documents

- [02_query_understanding_and_routing.md](02_query_understanding_and_routing.md)
- [03_retrieval_workers.md](03_retrieval_workers.md)
- [04_evidence_and_claims.md](04_evidence_and_claims.md)
- [05_verification_and_answer_gate.md](05_verification_and_answer_gate.md)
- [06_recovery_memory_and_harness.md](06_recovery_memory_and_harness.md)
- [../06_pipeline_runtime/02_online_query_pipeline.md](../06_pipeline_runtime/02_online_query_pipeline.md)
