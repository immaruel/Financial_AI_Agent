# 04. Evidence Requirement Gate, Context Builder, Claim-first Generator

## 1. Purpose

Having a list of retrieved `EvidenceBlock`s does not mean the LLM should generate an answer right away. First, code deterministically checks upfront whether the evidence modality the question actually requires has really been satisfied (`EvidenceRequirementGate`); only the evidence that passes is assembled into a budgeted context (`ContextBuilder`); and only then does the LLM produce atomic claims, unable to cite any evidence ID outside that context (`ClaimFirstGenerator`).

These three components form the key boundary between "the answer lacks evidence" and "retrieval succeeded but the generation stage couldn't use it."

---

## 2. Evidence Requirement Gate

`EvidenceRequirementGate.evaluate()` (`agent/requirements.py`) never calls an LLM. For every `required` item in `QuerySpec.evidence_needs`, it checks whether citable evidence actually exists.

### 2.1 Base Admissibility

Evidence must satisfy all of the following to count as "admissible":

- `citable=True`, `synthetic=False`
- `source_url` and `text` are non-empty
- A concrete locator exists (one of `page`/`xpath`/`css_selector`/`paragraph_id`/`table_id`/`char_start·end`)
- `published_at` is before `as_of` (prevents leaking information from the future)

### 2.2 Per-need Judgment

| Need | Passing condition | Reason code on failure |
|---|---|---|
| `graph_relation = required` | The graph worker succeeded, and a path exists that includes a meaningful relation type (`AFFECTS`, `CAUSED_BY`, `BELONGS_TO_INDUSTRY`, etc.) backed by admissible evidence. If the question asks about causation ("why," "cause"), that path's edge must have `causal=True` and an `inference_method` that is not a temporal-adjacency heuristic | `REQUIRED_GRAPH_WORKER_FAILED`, `REQUIRED_GRAPH_EVIDENCE_MISSING`, `REQUIRED_CAUSAL_GRAPH_EVIDENCE_MISSING` |
| `primary_source_quote = required` | A `paragraph`/`footnote` block from a primary source (`filing`/`earnings_transcript`/`ir`/`government`, etc.) exists; for a management-related question, speaker information (e.g. `locator.speaker`) is also checked | `REQUIRED_PRIMARY_SOURCE_QUOTE_MISSING` |
| `numeric_value = required` | Admissible evidence exists that contains an actual amount/ratio/count expression, not merely a year | `REQUIRED_NUMERIC_EVIDENCE_MISSING` |
| `table_or_figure = required` | For a table, both location and structure (`grid`/`headers`/`row_index`, etc.) are present; for a figure, location, human review (`human_reviewed`), the actual image asset, and OCR/vision output must all be present | `REQUIRED_STRUCTURED_VISUAL_EVIDENCE_MISSING` |

If any check fails, the gate returns `AnswerGateDecision(decision="repair", ...)` and the request goes straight into the Critic/Supervisor recovery loop without reaching generation. If every check passes, `decision="pass"`.

---

## 3. Context Builder

`ContextBuilder.build()` (`agent/context_builder.py`) produces a `ContextBundle` with an evidence-ID allowlist.

### 3.1 Assembly Order and Budget Management

```text
1. Exclude evidence published after as_of and non-citable/synthetic evidence;
   deduplicate by content_hash
2. Select up to policy.evidence_budget items of evidence
3. [QUERY SPEC] section: query_id, the original question, intent, entities, time, evidence_needs
4. [EVIDENCE BLOCKS] section: states explicitly that only these evidence_ids may be cited
5. If mode != "hybrid_only", add [GRAPH RELATION CONTEXT] and [TIMELINE] sections
6. If memory is in "selected" state, add a
   [USER PREFERENCES — NOT FACTUAL EVIDENCE; NEVER CITE] section
```

`mode` is one of `graph_hybrid`/`graph_primary`/`hybrid_only`, computed deterministically from the selected channel combination.

### 3.2 Only Whole Records Are Included

Text is never sliced arbitrarily. When budget runs short, an evidence entry is included whole or excluded entirely — a half-truncated JSON object is never left in the context, because that would make generation and the citation audit disagree with each other. When a table/figure block's `structured` field exceeds budget, it is abbreviated only as `{"truncated": true, "preview": "..."}`.

### 3.3 Memory Gets Its Own Section and Its Own Rules

User memory is clearly separated under a `[USER PREFERENCES — NOT FACTUAL EVIDENCE; NEVER CITE]` header and is never added to the evidence-ID allowlist. `ContextBundle.content_hash` is the sha256 of the entire rendered context, letting the ledger reproduce exactly what the LLM actually saw.

---

## 4. Claim-first Generator

`ClaimFirstGenerator.generate()` (`agent/generation.py`) never produces free-form prose first. It always produces a list of atomic claims first.

### 4.1 System Prompt

```text
You are a financial-research Claim-first Generator.
Using only the user's question and the provided EvidenceBlocks, write atomic
claim JSON.
Rules:
1. Each claim must contain exactly one independently verifiable fact.
2. evidence_ids may reference only evidence_id values present in the context.
3. User memory is a preference only, not factual evidence; never cite it.
4. Keep numbers, units, currency, and periods identical to the evidence.
5. Never turn PRECEDES or POSSIBLY_RELATED_AFTER into a causal claim. In
   particular, a path with edge_metadata.causal=false is only a temporal-
   adjacency retrieval hint.
6. If there is no evidence, do not create the claim.
7. Do not output fields outside the specified JSON Schema.
```

### 4.2 AtomicClaim Structure

```json
{
  "claims": [
    {
      "claim_id": "c1",
      "text": "Revenue increased 18% year over year.",
      "claim_type": "numeric",
      "evidence_ids": ["ev_456"],
      "importance": "critical"
    }
  ]
}
```

### 4.3 Allowlist Enforcement and Fallback

```text
1. Call the LLM → validate the schema + the evidence_id allowlist
   (citing an ID outside context.evidence_ids is rejected immediately)
2. A critical claim with empty evidence_ids is rejected
3. On validation failure, request one repair pass that restates the allowed evidence_id list
4. On repeated failure, use a deterministic fallback: extract sentences verbatim
   from the top 4 evidence items and classify claim_type (numeric/temporal/
   attribution/factual) by rule
```

The `fallback` never composes a new sentence — it cuts the first sentence directly from the evidence text — so even a complete LLM failure cannot produce an unsupported statement.

---

## 5. Position in the Data Flow

```text
[Retrieval Workers] → list of EvidenceBlocks
        ▼
[Evidence Fusion & Rerank] (03_retrieval_workers.md)
        ▼
[EvidenceRequirementGate]   ← this document
        │ only "pass" proceeds
        ▼
[ContextBuilder]   ← this document
        ▼
[ClaimFirstGenerator]   ← this document
        │ List[AtomicClaim]
        ▼
[DeterministicClaimVerifier + AnswerGate]  (05_verification_and_answer_gate.md)
```

---

## 6. Verification Points from a Harness Perspective

| Item | Meaning |
|------|---------|
| `requirement_gate_block_rate` | How often generation is blocked upfront for lack of evidence |
| `context_budget_utilization` | Share of `evidence_budget` actually used in context |
| `claim_allowlist_violation_rate` | How often the LLM attempted to cite evidence outside the context (and whether one repair pass recovered it) |
| `fallback_generation_rate` | Share of runs demoted to the deterministic fallback |
| `critical_claim_without_evidence_rate` | Share of critical-claim attempts rejected for lacking evidence |

Representative failure types: F5 missing evidence (gate blocking), F6 overstated reasoning (attempting to smuggle in unsupported causation).

---

## 7. Design Rationale

**Why a dedicated gate before generation?**
Because the LLM can produce a plausible-sounding sentence without real evidence, it is both cheaper and safer to deterministically block generation upfront than to detect the lack of evidence after the fact by verifying the generated output. If the gate fails, the LLM is never called.

**Why generate claims first and assemble the prose answer afterward?**
A free-form paragraph mixes multiple facts into one sentence, leaving no clean unit to verify. Splitting into claims lets each one be verified independently, so that only the claims that fail are removed or re-searched ([05_verification_and_answer_gate.md](05_verification_and_answer_gate.md), [06_recovery_memory_and_harness.md](06_recovery_memory_and_harness.md)).

**Why does the fallback "extract from evidence" rather than "generate a new sentence"?**
If the fallback wrote a new sentence when the LLM has completely failed, there would be a real risk of an unsupported statement slipping through. Extracting verbatim from the source text at least guarantees "this sentence really exists in the evidence."
