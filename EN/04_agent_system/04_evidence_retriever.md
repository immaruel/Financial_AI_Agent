# 04. Evidence Retriever Agent

## 1. Purpose

For the Event nodes explored by Graph Retriever inside `SubGraphResult`, recover the **original supporting passages**.

Graph nodes store structured event information, but original text is indexed separately inside `PassageIndex`. This module connects those two stores so the agent can "verify facts found in the graph directly against the source text." That raises answer reliability and makes source citation possible.

From a harness engineering perspective, Evidence Retriever is the **key module for separating "the answer lacks evidence" from "retrieval succeeded but citation support is weak."**

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `SubGraphResult` | GraphRetriever output |
| `InMemoryGraphStore`, including `PassageIndex` | source passage store |

### Output

`List[EvidenceResult]`

`EvidenceResult` structure:

| Field | Type | Description |
|------|------|-------------|
| `event_id` | str | Event ID for which evidence was retrieved |
| `evidences` | List[Dict] | List of source evidence items |
| `verification_status` | str | `confirmed` / `partial` / `unverified` |
| `conflicts` | List[str] | Descriptions of conflicting evidence |

Structure of each `evidences` item:

```python
{
    "passage_id": str,
    "text": str,
    "source_url": str,
    "title": str,
    "source_type": str,
    "published_at": str,
}
```

---

## 3. Processing Logic

### 3.1 Identify Event Nodes

Extract nodes from `SubGraphResult.nodes` where `label == "Event"` or `label == "EventCandidate"`.

### 3.2 Query `PassageIndex`

```python
for event_node in event_nodes:
    event_id = event_node["id"]

    # Index for CanonicalEvent
    passage_ids = graph_store.passage_index.event_to_passage_ids.get(event_id, [])

    # Index for EventCandidate, fallback if CanonicalEvent passages are missing
    if not passage_ids:
        passage_ids = graph_store.passage_index.event_candidate_to_passage_ids.get(event_id, [])
```

### 3.3 Recover Original Text

```python
for passage_id in passage_ids:
    record = graph_store.passage_index.passages.get(passage_id)
    if record:
        doc_record = graph_store.passage_index.documents.get(record.canonical_doc_id)
        evidence = {
            "passage_id": passage_id,
            "text": record.text,
            "source_url": doc_record.source_url if doc_record else "",
            "title": doc_record.title if doc_record else "",
            "source_type": doc_record.source_type if doc_record else "",
            "published_at": doc_record.published_at if doc_record else None,
        }
```

### 3.4 Detect Conflicting Evidence

Check whether evidence items connected to the same event conflict with each other.

```python
conflicts = []
for i, ev_a in enumerate(evidences):
    for ev_b in evidences[i+1:]:
        if _is_conflicting(ev_a["text"], ev_b["text"]):
            conflicts.append(f"'{ev_a['title']}' vs '{ev_b['title']}'")
```

Conflict rule: if a filing and a news item for the same event disagree on core attributes such as amount or timing.

### 3.5 Determine `verification_status`

```python
if any(ev["source_type"] == "filing" for ev in evidences):
    verification_status = "confirmed"
elif evidences:
    verification_status = "partial"
else:
    verification_status = "unverified"
```

---

## 4. Dependencies and Connected Modules

### Upstream

- `GraphRetrieverAgent` → `SubGraphResult`
- `InMemoryGraphStore.passage_index` → `PassageIndex`

### Downstream

- `CausalReasonerAgent` → uses `EvidenceResult` list
- `HypothesisCheckerAgent` → receives contradiction and unsupported-claim inputs
- `AnswerComposerAgent` → uses it to populate the `sources` field
- `RiskControllerAgent` → adds warnings when conflicting evidence exists

---

## 5. Position in the Data Flow

Agent pipeline **Step 3 / 7**. It uses Event node IDs from `SubGraphResult` as keys into `PassageIndex` and recovers source evidence.

```text
[GraphRetrieverAgent]  (Step 2 / 7)
        │  SubGraphResult
        ▼
[EvidenceRetrieverAgent]   ← This document (Step 3 / 7)
        │  List[EvidenceResult]
        ├──→ [CausalReasonerAgent]   (Step 4 / 7)
        ├──→ [HypothesisCheckerAgent] (Step 5 / 7)
        └──→ [AnswerComposerAgent]   (Step 6 / 7)
```

---

## 6. Verification Points from the Harness Perspective

Evidence Retriever is best validated with the following metrics.

| Item | Meaning |
|------|---------|
| `evidence_recall@k` | whether it recovered the core source passages needed for the answer |
| `evidence_precision@k` | whether the recovered evidence is actually relevant |
| `citation_coverage` | whether core claims receive citations |
| `contradiction_recall` | whether opposing or conflicting evidence was missed |
| `verification_status distribution` | whether the ratio of confirmed / partial / unverified is reasonable |

Evidence trace should include:

- selected evidence IDs per event ID
- ranking score or selection rationale
- source-type distribution across filings and news
- whether contradiction evidence was included

Representative failure types:

- F5 missing evidence
- downstream symptoms of F2 temporal error
- upstream causes of F6 overstated reasoning

---

## 7. Implementation Design Standards

### Linking the Graph and `PassageIndex`

`PassageIndex` is built in [03_knowledge_graph/03_graph_loader.md §3.9](../03_knowledge_graph/03_graph_loader.md). `GraphPayloadBuilder.build()` constructs it and stores it in `GraphPayload.passage_index`. `InMemoryGraphStore.load_payload()` then stores it as `self.passage_index`.

```text
CanonicalEvent.evidence (EvidenceSpan)
        │
        ▼  indexed in GraphPayloadBuilder
PassageIndex.event_to_passage_ids[event_id] = [passage_id, ...]
PassageIndex.passages[passage_id] = PassageRecord(text=..., canonical_doc_id=...)
PassageIndex.documents[canonical_doc_id] = DocumentTextRecord(title=..., source_url=...)
```

### Events Without Evidence

If an event has no passage inside `PassageIndex`, mark it with `verification_status = "unverified"`. Answer Composer then adds a warning that the event lacks a clear source reference.

---

## 8. Design Rationale

**Why recover original text through `PassageIndex` instead of only through graph edges?**  
Recovering source text through graph traversal, `SUPPORTED_BY → FROM_DOCUMENT`, incurs repeated edge-walk cost. `PassageIndex` provides `event_id → passage_id` lookup in `O(1)`. The graph edges are still preserved because they remain useful for structural graph exploration.

**Why detect conflicting evidence?**  
Financial events are often described with different numbers or dates in filings and news. If Risk Controller is expected to validate whether "conflicting news and filings exist," then that conflict must already be detected at this stage. Conflict information is stored in `StructuredAnswer.counter_evidence`.
