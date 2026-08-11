# 05. Deterministic Claim Verifier and Answer Gate

## 1. Purpose

Check each generated `AtomicClaim` against the evidence it cites for **entailment, numeric/unit agreement, temporal consistency, attribution, and relation direction**, then aggregate the results to gate the whole answer into `pass`/`repair`/`abstain`. This module deliberately avoids an LLM judge — a reproducible baseline must be passed first, so that attaching a separate LLM judge to genuinely ambiguous cases later remains safe.

`VerificationPipeline` in `agent/verification.py` wraps `DeterministicClaimVerifier` (claim-evidence pair verification) and `AnswerGate` (claim set → final gate).

---

## 2. Claim-level Pre-checks

Before pair verification, claims themselves are filtered.

- **Atomicity**: if a claim mixes multiple sentences/clauses (a `;` or several sentences), it is rejected immediately as `invalid` — a claim whose verification unit is not split cannot express partial failure.
- **Citation presence**: an empty `evidence_ids` yields `unsupported` (`citation_missing`).

---

## 3. Claim-Evidence Pair Verification (`verify_pair`)

For every `(claim, evidence)` pair, the following are computed independently and feed into the entailment verdict.

### 3.1 Entailment (lexical, precision-first)

- An exact substring match (after stripping whitespace/punctuation) yields `support`.
- Otherwise the result stays `unknown` — this deterministic baseline never upgrades a paraphrase to `support` on its own (`semantic_verifier_required_for_paraphrase`); numeric/relation checks below may still grant `support` separately.
- If negation markers (`not`, `없다`, etc.) differ between claim and evidence, the result becomes `contradict`.
- If a predefined antonym pair (increase↔decrease, strengthen↔weaken, etc.) appears on each side respectively, the result becomes `contradict` (`semantic_opposition`).

### 3.2 Relation Direction and Causality (`_relation_semantics`)

- If the claim has a causal marker (cause, lead to, etc.) but the evidence has none, the result is `fail`/`unknown` — the absence of causal wording in evidence is never treated as counter-evidence.
- Directed relation phrases (supply, acquisition, etc.) are extracted from both claim and evidence; if the subject and object are reversed, the result is `fail`/`contradict` (`relation_direction_reversed`).

### 3.3 Numeric (`_verify_numeric`)

- Percentages, KRW/foreign-currency amounts, and counts are parsed as `Decimal` and compared without floating-point error.
- Every number in a claim must match within **one atomic evidence scope** (a sentence/clause, one table row, or a single table cell) at the same time — this prevents stitching a metric label from one row and a value from a different row into a false "confirmed" match.
- A percentage-change claim is checked by recomputing `(current - previous) / |previous| * 100` from two absolute values found in the same scope (`_derived_growth_match`) — verification works even when the evidence has no precomputed growth rate.
- A number derived via OCR/vision (`derivation`) always fails unless `human_reviewed=True` (`derived_visual_numeric_requires_human_review`).
- Unit/currency mismatches (e.g., `%` vs. `%p`) fail explicitly.

### 3.4 Temporal (`_verify_temporal`)

- If `evidence.published_at` is after `as_of`, it fails (`evidence_published_after_as_of`) — blocking leakage of future information.
- If a period stated in the claim (quarter/year/date) is absent from the evidence's period, section, table header, or caption, it fails (`claim_period_not_supported`).

### 3.5 Attribution (`_verify_attribution`)

- The speaking subject is extracted from phrases like "X stated that ..." in the claim and compared against `source_name`/`locator.speaker`/the evidence body. A mismatch fails.

### 3.6 Locator (`_has_clickable_locator`)

- Even if evidence is `citable` and has a `source_url`, it still fails unless it has a page/anchor/paragraph/table position — this separately verifies "can a click actually reach that location?"

### 3.7 Definition of Valid Support/Contradiction

```text
valid_support   = entailment == "support"
                   AND numeric/temporal/attribution/relation_status != "fail"
                   AND locator_status == "pass"
valid_contradiction = entailment == "contradict"
                   AND temporal_status != "fail"
                   AND locator_status == "pass"
```

---

## 4. Determining Claim Status (`verify_claim`)

The verifier does not only re-check the cited evidence; it also searches **other retrieved-but-uncited candidates** covering the same metric/period and re-checks them (`_is_reconciliation_candidate`) — this stops the generator from citing only whichever source is convenient while hiding a conflicting one.

| Condition | Claim status |
|---|---|
| Both a valid support and a valid contradiction exist | `conflict` |
| Valid support exists, but another citation on the claim is invalid | `invalid` (one good source cannot cover for another invalid citation) |
| Only valid support exists | `supported` |
| Only valid contradiction exists | `contradicted` |
| Evidence missing, or any of numeric/temporal/attribution/relation/locator is `fail` | `invalid` |
| Otherwise | `unsupported` |

Even after a `supported` verdict, three additional checks can still demote it:

- Does the claim actually match the period the query requested (`_claim_matches_query_period`)?
- For `time.value == "latest_available"` queries, is the cited evidence actually the most recent among relevant candidates (`_supports_are_latest`)?
- Is the claim actually relevant to the original question's focus tokens (`_query_claim_relevance`) — this prevents smuggling in an evidence-backed but off-topic fact.

If any of these fail, a claim that was `supported` is demoted to `unsupported`.

---

## 5. Answer Gate

`AnswerGate.evaluate()` takes the claim list and verdicts and produces the final decision.

```text
critical_coverage = share of critical claims that are supported
coverage          = share of core (non-"supporting") claims that are supported

blocking conditions (any one triggers an immediate block):
  - a critical claim is contradicted
  - any claim is in the conflict state
  - a critical claim's numeric verification fails (block_critical_numeric_failure)
  - attribution verification fails (block_attribution_failure)
  - a critical claim's evidence was published after as_of (critical_temporal_leakage)

decision =
  pass    if thresholds are met AND no failed claims AND no blocking condition
  abstain if a blocking condition holds
  repair  otherwise (subject to retry/replan)
```

Falling below `critical_citation_coverage`/`normal_citation_coverage` adds its own reason code (`critical_citation_coverage_below_threshold`, `citation_coverage_below_threshold`).

### 5.1 Why `conflict` Leads to `abstain`, Not `repair`

When both supporting and contradicting evidence are valid, arbitrarily picking one side and retrying cannot uncover "the real answer." In this case the system does not try to solve the problem by re-searching — it either exposes the conflict as-is (the `conflicts` field in `_render_answer`) or withholds the answer.

---

## 6. Position in the Data Flow

```text
[ClaimFirstGenerator]  (04_evidence_and_claims.md)
        │  List[AtomicClaim]
        ▼
[DeterministicClaimVerifier.verify()]   ← this document
        │  List[ClaimVerdict]
        ▼
[AnswerGate.evaluate()]   ← this document
        │  AnswerGateDecision (pass / repair / abstain / clarification)
        ├─ pass  → Answer Renderer (06_recovery_memory_and_harness.md)
        └─ other → CriticAgent → Supervisor  (06_recovery_memory_and_harness.md)
```

---

## 7. Verification Points from a Harness Perspective

| Item | Meaning |
|------|---------|
| `citation_coverage` / `critical_citation_coverage` | Is the core claim sufficiently backed by supporting evidence? |
| `conflict_rate` | How often is conflicting evidence found? |
| `numeric_verification_fail_rate` | How often does numeric/unit/period recomputation fail? |
| `unknown_entailment_rate` | Share left as `unknown` because it is not an exact match (a signal for whether a semantic judge is needed) |
| `locator_fail_rate` | Share of citable evidence that still lacks a clickable position |
| `answer_gate_decision distribution` | Ratio of pass/repair/abstain |

Representative failure types: F3 numeric error (numeric fail), F2 temporal error (temporal fail), F4 event-attribution error (attribution fail), F6 overstated reasoning (relation fail).

---

## 8. Design Rationale

**Why put deterministic verification first, without an LLM judge?**
An LLM judge is useful but can itself be wrong, so handing the entire verification layer to the LLM risks a circular failure — "the generator's mistake gets verified by the generator." A precision-first baseline (exact match, `Decimal` recomputation, explicit antonym/direction rules) is passed first, leaving an extension path where a separate judge is added only for cases the baseline structurally leaves as `unknown`, such as ambiguous paraphrase.

**Why compare numbers only within a single "scope" rather than across the whole table?**
A table can mix multiple metrics and periods within one document. Pulling the metric label from one row and the value from another and matching them could confirm a combination that never actually existed. Forcing the match into a single row/sentence/cell prevents this kind of false positive.

**Why re-check uncited candidates too?**
If the generator cites only whichever source is convenient, the verification layer would otherwise just pass that bias through unchallenged. Forcing a re-check against other retrieved candidates covering the same metric/period keeps a conflicting source from being hidden.
