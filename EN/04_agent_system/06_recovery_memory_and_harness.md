# 06. Critic/Supervisor Recovery, User Memory, and Risk Management

## 1. Purpose

Define who decides retry, replan, or termination when the Answer Gate is not `pass` and by what rules (Critic/Supervisor); how user personalization is injected while staying separate from factual evidence (User Memory); and where safety is checked one more time before the final answer is returned (Risk & Harness).

---

## Part 1: Critic and Supervisor

### 1.1 Separation of Roles

| Role | Class | Responsibility |
|---|---|---|
| Critic | `CriticAgent` (`agent/supervisor.py`) | Reads gate reason codes + worker failures and diagnoses **candidate next actions** |
| Supervisor | `Supervisor` (`agent/supervisor.py`) | **Approves only allowed actions** among the Critic's proposals, and blocks repeated retries of the same failure |

The Critic does not praise or criticize the answer in general terms. It always returns a structured diagnosis in the shape `RecoveryDecision(decision, reason_codes, failed_claim_ids, next_actions)`.

### 1.2 Diagnosis Priority (`CriticAgent.diagnose`)

```text
1. If entities are ambiguous/unresolved and no worker has run yet
   -> decision="clarification", action=ask_clarification
2. If retries_remaining <= 0
   -> decision="abstain", reason += RETRY_BUDGET_EXHAUSTED
3. If evidence_conflict or claim_conflict is present in the reasons
   -> decision="abstain" (conflicting evidence cannot be resolved by retrying; CONFLICT_REQUIRES_DISCLOSURE)
4. Graph-worker-failure-family codes
   -> action=run_graph_retrieval
5. Document-block-worker-failure / numeric·temporal·attribution-verification-failure-family codes
   -> action=run_document_block_retrieval
6. Hybrid-worker-failure / insufficient-citation-family codes
   -> action=run_hybrid_text_retrieval (filters.expand_terms=True)
7. Any other claim failure
   -> action=remove_claim
```

### 1.3 Supervisor Control

```python
def register_failure(self, worker, input_hash, failure_code) -> bool:
    key = (worker, input_hash, failure_code)
    self._attempts[key] += 1
    return self._attempts[key] <= self.config.max_same_failure_retries

def authorize(self, decision: RecoveryDecision) -> RecoveryDecision:
    approved = [a for a in decision.next_actions if a.action in self.config.allowed_recovery_actions]
    if not approved:
        return RecoveryDecision(decision="abstain", reason_codes=[..., "RECOVERY_ACTION_REJECTED"], ...)
    return decision.model_copy(update={"next_actions": approved})
```

- Any action not present in `allowed_recovery_actions` is automatically downgraded to `abstain`, even if the Critic proposed it.
- Once a `(worker, input_hash, failure_code)` combination exceeds `max_same_failure_retries`, the system stops retrying for that same cause — a safeguard against repeating the same search forever.
- `Supervisor.reset()` is called at the start of every query (session), so a previous query's retry counters never leak into a new one.

### 1.4 Executing a Retry

`AgentOrchestrator._run_recovery_worker()` turns an approved action into an actual worker call.

| Action | Execution |
|---|---|
| `run_graph_retrieval` | Copies the policy, adds `graph` to `channels`, re-runs with `graph_mode="assist"` |
| `run_document_block_retrieval` | Narrows the policy to `channels=["document_block"]` and re-runs |
| `run_hybrid_text_retrieval` | If `expand_terms=True`, re-searches with a copy of `QuerySpec` deterministically expanded with intent-specific terms (management/relationship/impact, etc.); also clears `source_filters` to broaden scope. `as_of` and intent are never changed |
| `remove_claim` | Removes only the failed claim(s) and re-verifies the remainder; if that also fails, abstain |

Evidence gained from a retry is fused and reranked together with the existing evidence, and the gate → generation → verification loop repeats. The loop is a `while True`, but each iteration consumes retry budget and the Supervisor blocks repeated failures, so it never becomes infinite.

---

## Part 2: User Memory

### 2.1 Principle

User memory is **not factual evidence.** It is auxiliary context that shapes the answer's perspective, comparison baseline, or risk focus, and it never substitutes for a company-fact claim's citation. Normal `process_query` execution never writes memory: questions, answers, and retrieved evidence are not automatically turned into a profile.

The separate write lifecycle is `user preference/feedback → MemoryLifecycleAgent (LLM proposes structured MemoryCandidateDraft only) → deterministic policy validation → pending confirmation or approved → UserMemoryStore.create/write`. The model cannot select tenant/user scope, provenance, IDs, or call a write API. By default `auto_commit_explicit=False`; even an explicit preference is confirmed. Auto-commit is possible only when that product policy is deliberately enabled and confidence meets `min_auto_commit_confidence` (0.90 by default). Implicit inferences always require confirmation.

### 2.2 Storage Structure

```json
{
  "memory_id": "mem_...",
  "tenant_id": "tenant_a",
  "user_id": "user_1",
  "kind": "investment_framework",
  "content": {"risk_preference": "conservative", "focus": ["cash_flow"]},
  "entities": ["company:005930"],
  "industries": ["semiconductor"],
  "intents": [],
  "valid_from": "2026-01-01T00:00:00+09:00",
  "valid_until": null,
  "created_at": "2026-01-01T00:00:00+09:00",
  "source": "explicit_user_feedback",
  "superseded_by": null,
  "persistence": "long_term",
  "session_id": ""
}
```

- Permitted candidate kinds are only `answer_format`, `investment_framework`, `risk_preference`, `watchlist`, `sector_exclusion`, `language_preference`, and `citation_preference`. Evidence/citation/answer/company-fact/financial-result keys and credentials or direct identifiers are rejected. A company result is a research claim, not a preference memory.
- `turn` memory is removed after selection for one relevant query in the same `session_id`; `session` memory is process-local and visible only in that same session; only `long_term` can enter the opt-in encrypted store.
- `anonymous` is never treated as a stable user identity — if `user_id` is empty or `anonymous`, memory selection returns `disabled` outright (to prevent leaking one visitor's preferences into another's).
- `update()` never edits a record in place; it versions into a new ID and stamps the old record's `superseded_by`, so a past audited answer's preference version stays reproducible.
- Persistent storage (`persistent=True`) is opt-in, and when `MemoryConfig.require_encryption=True`, writes are refused unless a Fernet key is configured.

### 2.3 Relevance Selection (`UserMemoryStore.select`)

Computed deterministically from `QuerySpec` and memory metadata alone — no LLM call.

```text
1. Keep only records valid for tenant/user scope (and matching session_id for ephemeral records), valid_from/valid_until, and not superseded
2. If multiple active records share the same persistence/session_id/kind/entities/industries/intents combination
   (a conflict key), keep only the most recent and exclude the rest as
   conflict_shadowed_by_newer
3. Add +4.0 for entity, +2.5 for industry, and +2.0 for intent/sub-intent overlap
4. For entirely untagged memories only, add +1~2.0 for lexical overlap with the raw query text
5. Drop anything below min_rule_score; select by score within max_selected_memories/token_budget
```

The selection result (`MemorySelection`) records `status`, `memory_ids`, `reasons`, and `excluded` (with reasons) so it can be fully audited in the ledger — though the ledger stores only a `content_hash`, never the memory content itself.

### 2.4 How Memory Appears in the Answer

`ContextBuilder` reserves the selected memory budget *before* expanding evidence, graph paths, and timeline. It renders only actually injected records inside `[USER PREFERENCES — NOT FACTUAL EVIDENCE; NEVER CITE]`. `ContextBundle.memory_ids` means injected IDs; `selected_memory_ids`, `omitted_memory_ids`, and `memory_omission_reasons` distinguish selection from a budget omission. The ledger stores content hashes and these IDs/counts, never the raw preference content.

---

## Part 3: Risk Management and the Harness Post-check

### 3.1 Three Layers of Safety

| Layer | When | Mechanism |
|---|---|---|
| Evidence Requirement Gate | Before generation | Blocks upfront based on evidence modality ([04_evidence_and_claims.md](04_evidence_and_claims.md)) |
| Answer Gate | After generation, per claim | Blocks on citation/numeric/temporal/attribution verification failure ([05_verification_and_answer_gate.md](05_verification_and_answer_gate.md)) |
| Harness post-check | After the answer is finalized | `PipelineHarness` (`harness/runtime.py`) re-checks against the F1-F8 taxonomy and decides whether review is required |

Each layer catches a different kind of failure. The first two ask "is this claim actually backed by evidence?" The harness layer asks "even so, does investment-advice-like or over-confident phrasing remain, is there a freshness issue, is human review needed?"

### 3.2 Answer Renderer (`AgentOrchestrator._render_answer`)

Only claims that pass the gate enter the final answer.

```text
gate.decision == "pass"          -> compose the summary from accepted claims, status="completed"
any claim in conflict            -> neither side is asserted; both supporting and contradicting
                                     evidence are shown, status="partial"
gate.decision == "clarification" -> ask the user to specify the target/period, status="clarification"
otherwise (e.g. abstain)         -> "The verifiable source evidence secured as of the current
                                     reference time is not sufficient to answer this question
                                     reliably.", status="abstained"
```

Every answer carries these fixed warnings.

```text
"User memory is used only for personalization and is never cited as factual evidence."
"This answer is research material to help verify source evidence and is not investment advice."
```

### 3.3 The Harness's F1-F8 Post-check (`PipelineHarness._verify_online`)

`harness/runtime.py` re-inspects the `AgentRunResult` and produces a `VerificationSummary`/`FailureCase`.

| Check | Code |
|---|---|
| Graph was selected but seeds/subgraph are empty | F1 |
| No citable EvidenceBlock found at all; insufficient evidence relative to core events | F5 |
| Conflicting evidence exists but isn't reflected in the answer's counter-evidence | F5 |
| The final answer has no sources | F5 |
| The Answer Gate did not pass | F5 |
| Investment-advice/over-confidence keywords ("buy," "sell," "recommend," "guaranteed," "certain," "definitely," etc.) detected above threshold | F7 |
| The query was classified `high-risk` (buy/sell/recommend keywords, etc.) but answer confidence is low | F7 |
| Answer confidence is low | F8 |

This keyword-based advice-risk check runs independently of claim verification, as a **last line of defense** — it re-checks even sentences that already passed verification for remaining risky phrasing. `_apply_online_feedback()` uses this result to augment `risk_warnings` and update `human_review_required`, but it never edits the text of a claim that passed the gate — doing so would make the `CitationLedger`'s hash disagree with the actual returned answer.

### 3.4 Human Review

Once `human_review_required=True`, a `review_ticket` (run_id, risk_class, failure_codes, trace_paths) is attached to the answer. The conditions that trigger human review are described in [01_agent_architecture.md §11](01_agent_architecture.md).

### 3.5 Connection to Real-time Supplemental Collection

Only when the Answer Gate has exhausted its retry budget and still ends in `abstain`, and the root cause has narrowed to "the KG/corpus simply has no information" (`RETRIEVAL_EMPTY`/`INSUFFICIENT_PRIMARY_EVIDENCE` and retryable), does `FinancialKGPipeline.query()` in `main.py` run real-time supplemental collection (`_online_supplement`) once, merge it into the KG, and re-run the same query. Every other recovery channel (graph/document/text expansion) is tried before this real-time collection step — see [06_pipeline_runtime/02_online_query_pipeline.md](../06_pipeline_runtime/02_online_query_pipeline.md) for details.

---

## 4. Verification Points from a Harness Perspective

| Item | Meaning |
|------|---------|
| `recovery_success_rate` | Share of Critic/Supervisor retries that actually reach `pass` |
| `same_failure_retry_block_rate` | How often retries are blocked for repeating the same failure |
| `memory_selection_precision` | Is selected memory actually relevant to the query? |
| `advice_risk_hit_rate` | How often F7 fires in the harness post-check |
| `human_review_rate` | Share of queries that produce a `review_ticket` |

Representative failure types: F1/F5 (recovery attempts), F7 (harness post-check), F8 (over-abstention — a signal the retry policy may be too conservative).

---

## 5. Design Rationale

**Why not repeat self-repair indefinitely?**
There is no guarantee that re-searching will always surface the relevant information. Retries are blocked per `(worker, input_hash, failure_code)`, and a `retry_budget` is enforced, so after a set number of attempts the system switches to safe failure (`abstain`/`clarification`) or human review.

**Why does the harness re-check advice-risk with keywords, separately from claim verification?**
Claim verification only asks "is this sentence backed by evidence?" Even a well-supported sentence can still read as investment advice or overconfidence, so factual verification and expression-safety verification are checked independently, at different layers.

**Why doesn't the harness edit claim text after the fact?**
If the harness modified a sentence that already passed the verifier, the `CitationLedger`'s `final_answer_hash` would no longer match the answer actually returned. The harness only appends warnings/status; it preserves the verified claim body as-is.
