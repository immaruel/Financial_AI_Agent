# 06. Event Canonicalization

## 1. Purpose

Compare `EventCandidate` objects extracted from multiple documents and merge them into a single `CanonicalEvent` when they are substantively the same event.

This stage is the **third deduplication layer**. After the first layer, document-level duplication detection, and the second layer, event-candidate extraction, it performs the final duplicate removal at the event level. Without this step, the same event would be loaded into the KG once for every news article that covered it.

From a harness engineering perspective, Event Canonicalization is a **critical failure localization point in the offline layer**. If merging is done incorrectly here, downstream retrieval, evidence recovery, reasoning, and answer generation all become unstable.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `List[EventCandidate]` | Event candidates extracted from all documents |
| `EventCanonicalizationConfig` | Similarity thresholds, time window, and field weights |

### Output

`List[CanonicalEvent]`

`CanonicalEvent` structure:

| Field | Type | Description |
|------|------|-------------|
| `canonical_event_id` | str | UUID, prefix `canon_evt_` |
| `event_type` | str | Representative event type |
| `event_subtype` | str | Representative subtype |
| `subject_entity_id` | str | Subject `canonical_entity_id` |
| `object_entity_id` | str | Object `canonical_entity_id` |
| `amount` | float | Representative amount, with filings preferred |
| `currency` | str | Currency, default `KRW` |
| `event_time` | datetime | Representative occurrence time |
| `effective_time` | datetime | Representative effective time |
| `polarity` | Polarity | Representative polarity |
| `certainty` | Certainty | Representative certainty |
| `source_event_candidate_ids` | List[str] | List of merged `EventCandidate` IDs |
| `source_canonical_doc_ids` | List[str] | List of supporting document IDs |
| `representative_source_type` | str | Representative source type |
| `confidence` | float | Highest confidence among merged items |
| `trigger_text` | str | Representative trigger expression |
| `evidence` | List[EvidenceSpan] | All collected evidence spans |

---

## 3. Processing Logic

### 3.1 Candidate Blocking

Do not compare every `EventCandidate` with every other one. Only compare pairs that satisfy all of the following.

```text
Blocking conditions, all must match:
  - same event_type
  - same subject_entity_id
  - event_time difference ≤ time_window_days (default: 7 days)
```

### 3.2 Similarity Calculation

Within each blocked candidate group, compute a weighted sum across the following fields.

| Field | Weight | Comparison method |
|------|--------|-------------------|
| `event_type` | 0.25 | exact equality, 1.0 or 0.0 |
| `subject_entity_id` | 0.25 | exact equality, 1.0 or 0.0 |
| `object_entity_id` | 0.15 | equality with `None` handling |
| `amount` | 0.15 | normalized numeric similarity |
| `event_time` | 0.10 | inverse of day-level time difference |
| `trigger_text` | 0.10 | text similarity |

```python
similarity = sum(
    field_weights[field] * similarity_score(cand_a[field], cand_b[field])
    for field in field_weights
)
```

### 3.3 Decision Rules

| similarity | Action |
|------------|--------|
| ≥ 0.85 (`same_event_threshold`) | definite merge into the same `CanonicalEvent` |
| 0.65 ~ 0.85 (`maybe_same_threshold`) | merge with low confidence and warning flag |
| < 0.65 | treat as separate events and create a new `CanonicalEvent` for each |

### 3.4 Representative Value Selection on Merge

Among the `EventCandidate` objects grouped into the same event, select representative values using the following priority.

```python
source_priority = {
    "filing": 1,    # filings first
    "news": 2,
    "analysis": 3,
}
```

| Attribute | Representative value rule |
|-----------|---------------------------|
| `amount` | Prefer the value from a candidate where `source_type == "filing"` |
| `event_time` | Prefer filing `effective_time`; otherwise use the earliest `event_time` |
| `representative_source_type` | Use the `source_type` with the lowest source priority value |
| `confidence` | Use the highest confidence among merged candidates |
| `evidence` | Preserve the union of all `EvidenceSpan` objects |
| `source_canonical_doc_ids` | Keep the full list of supporting documents |

---

## 4. Dependencies and Connected Modules

### Upstream

- `event_extractor.py` → list of `EventCandidate`

### Downstream

- `graph_loader.py` → converts `CanonicalEvent` into event nodes
- `PassageIndex` → indexes passages from `CanonicalEvent.evidence`

### External Dependencies

- `EventCanonicalizationConfig` (`config/settings.py`): thresholds, weights, time window

---

## 5. Position in the Data Flow

```text
[Event Extractor]
        │  List[EventCandidate] (all documents)
        ▼
[Event Canonicalizer]   ← This document
        │  List[CanonicalEvent]
        ▼
[Graph Loader]  →  Event nodes + HAS_EVENT edges + PRECEDES edges
```

---

## 6. Verification Points from the Harness Perspective

Event Canonicalization should be evaluated separately on the following dimensions.

| Item | Meaning |
|------|---------|
| `canonical_grouping_accuracy` | Whether substantively identical events were grouped correctly |
| `over_merge_rate` | Whether different events were merged too aggressively |
| `under_merge_rate` | Whether identical events were left as multiple canonical events |
| `representative_value_accuracy` | Whether representative amount, time, and source were chosen correctly |
| `event_to_evidence_preservation` | Whether evidence is preserved sufficiently after merging |

Recommended trace:

- candidate → canonical_event mapping
- similarity score
- blocking key
- whether a low-confidence merge occurred
- rationale for representative source selection

Representative failure types:

- F2 temporal error
- F3 numeric error
- F4 event attribution error
- F5 missing evidence

---

## 7. Implementation Design Standards

### Processing Flow

```python
def canonicalize(self, event_candidates: List[EventCandidate]) -> List[CanonicalEvent]:
    canonical_events = []

    for candidate in event_candidates:
        # 1. Blocking: select comparison pool
        comparison_pool = self._get_comparison_pool(candidate, canonical_events)

        # 2. Similarity calculation
        best_match, best_score = self._find_best_match(candidate, comparison_pool)

        # 3. Decision and merge
        if best_score >= self.config.same_event_threshold:
            self._merge_into(candidate, best_match)
        elif best_score >= self.config.maybe_same_threshold:
            self._merge_into(candidate, best_match, low_confidence=True)
        else:
            canonical_events.append(self._create_new(candidate))

    return canonical_events
```

### Preserve Evidence by Aggregation

When merging, aggregate all `EvidenceSpan` objects from the grouped candidates into the `CanonicalEvent`. This allows the agent's Evidence Retriever to cross-check the same event across multiple original sources.

---

## 8. Design Rationale

**Why use blocking?**  
If all `N` event candidates are compared with each other, the process becomes `O(N²)`. Large document sets can create tens of thousands of event candidates. Restricting comparison pools first with `event_type + subject_entity_id + time_window` reduces the effective complexity toward `O(N × k)`, where `k` is the average blocked candidate count.

**Why treat the 0.65 to 0.85 range separately?**  
News reports often contain less complete time and amount information than filings, so substantively identical events may fail to reach 0.85 similarity. Merging them with low confidence preserves the event while still letting the agent know the merge is uncertain.
