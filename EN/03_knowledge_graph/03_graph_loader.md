# 03. Graph Loading Pipeline

## 1. Purpose

Convert the final outputs of the preprocessing pipeline, `ResolvedMention`, `CanonicalEvent`, and `CanonicalDocument`, into graph nodes and edges, then load them into `InMemoryGraphStore`.

This stage is the endpoint of the offline pipeline and the place where the actual KG explored by the agent is completed. It also builds `PassageIndex` so the agent's Evidence Retriever can jump directly from events to source passages.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `List[ResolvedMention]` | Resolved entity mentions across all documents |
| `List[CanonicalEvent]` | Output of Event Canonicalization |
| `List[CanonicalDocument]` | Source document metadata |
| `List[EventCandidate]` | Optional pre-canonicalization candidates, used for PassageIndex construction |
| `Neo4jConfig` | Loading configuration, including batch size and PRECEDES time window |
| `ReferenceDataManager` | Reference data for company-industry mapping |

### Output

`GraphPayload`

```python
class GraphPayload:
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    passage_index: Optional[PassageIndex]
    seed_nodes: List[str]   # core node IDs newly loaded
```

---

## 3. Processing Logic

`GraphPayloadBuilder.build()` runs in the following order.

### 3.1 Create Company Nodes

Convert items in `ResolvedMention` where `entity_type == "Company"` and `resolution_status == "resolved"` into Company nodes.

```python
node = GraphNode(
    node_id=mention.canonical_entity_id,
    label="Company",
    properties={
        "name": mention.canonical_name,
        "canonical_entity_id": mention.canonical_entity_id,
        # Add ticker, corp_code, and more from ReferenceDataManager
    }
)
```

### 3.2 Create Industry Nodes and `BELONGS_TO_INDUSTRY` Edges

Generate these from company-industry mappings in `ReferenceDataManager`. Article-context inference is not used.

```python
for company_id, industry_ids in ref_data.company_industry_map.items():
    for industry_id in industry_ids:
        edges.append(GraphEdge(
            source_id=company_id,
            target_id=industry_id,
            edge_type="BELONGS_TO_INDUSTRY",
            properties={"source": "reference_data", "confidence": 1.0}
        ))
```

### 3.3 Create Event Nodes and `HAS_EVENT` Edges

Convert `CanonicalEvent` into Event nodes and create `HAS_EVENT` edges that connect them to `subject_entity_id`.

```python
event_node = GraphNode(
    node_id=event.canonical_event_id,
    label="Event",
    properties={
        "event_type": event.event_type,
        "event_time": _safe_iso(event.event_time),
        "polarity": _enum_value(event.polarity),
        "certainty": _enum_value(event.certainty),
        "confidence": event.confidence,
        "trigger_text": event.trigger_text,
        ...
    }
)

has_event_edge = GraphEdge(
    source_id=event.subject_entity_id,
    target_id=event.canonical_event_id,
    edge_type="HAS_EVENT",
    properties={"role": "subject", "confidence": event.confidence}
)
```

**Skip conditions for `HAS_EVENT`:**

- `subject_entity_id` is `None` or empty
- the subject entity does not exist in the graph

### 3.4 Create `INVOLVES` Edges

If `object_entity_id` exists, connect the Event to the target entity.

```python
if event.object_entity_id:
    edges.append(GraphEdge(
        source_id=event.canonical_event_id,
        target_id=event.object_entity_id,
        edge_type="INVOLVES",
        properties={"role": "counterparty", "confidence": event.confidence}
    ))
```

### 3.5 Create Document Nodes

Convert `CanonicalDocument` into Document nodes.

### 3.6 Create Evidence Nodes and `SUPPORTED_BY` + `FROM_DOCUMENT` Edges

Convert each `EvidenceSpan` in `CanonicalEvent.evidence` into an Evidence node and build the chain Event → Evidence → Document.

```python
evidence_id = _build_passage_id(
    canonical_doc_id, sentence_id, char_start, char_end, text
)  # deterministic SHA-1-based ID

evidence_node = GraphNode(node_id=evidence_id, label="Evidence", ...)
supported_by  = GraphEdge(source_id=event_id, target_id=evidence_id, edge_type="SUPPORTED_BY")
from_document = GraphEdge(source_id=evidence_id, target_id=doc_id, edge_type="FROM_DOCUMENT")
```

### 3.7 Create `DISCLOSED_IN` / `REPORTED_IN` Edges

```python
if source_type == "filing":
    edge_type = "DISCLOSED_IN"
elif source_type == "news":
    edge_type = "REPORTED_IN"
```

### 3.8 Create `PRECEDES` Edges

Sort each company's Event list by ascending `event_time` and create edges between consecutive pairs whose time gap is within `precedes_max_lag_days`, 30 days.

```python
for company_id, event_ids in company_event_map.items():
    sorted_events = sorted(event_ids, key=lambda e: events[e].event_time)
    for i in range(len(sorted_events) - 1):
        e1, e2 = sorted_events[i], sorted_events[i+1]
        lag = (events[e2].event_time - events[e1].event_time).days
        if lag <= config.precedes_max_lag_days:
            edges.append(GraphEdge(
                source_id=e1, target_id=e2,
                edge_type="PRECEDES",
                properties={"lag_days": lag}
            ))
```

### 3.9 Build `PassageIndex`

Index all `EvidenceSpan` objects from both events and EventCandidates into `PassageIndex`.

```python
passage_index.event_to_passage_ids[event_id].append(passage_id)
passage_index.passages[passage_id] = PassageRecord(
    text=span.text,
    canonical_doc_id=span.canonical_doc_id,
    ...
)
```

The structure of `PassageIndex` is defined in [03_knowledge_graph/02_graph_schema.md §4](02_graph_schema.md). The component that actually queries it is [04_agent_system/04_evidence_retriever.md §3.2](../04_agent_system/04_evidence_retriever.md).

---

## 4. Dependencies and Connected Modules

### Upstream

- `event_canonicalizer.py` → `CanonicalEvent`
- `entity_resolver.py` → `ResolvedMention`
- `document_fingerprint.py` → `CanonicalDocument`
- `reference/company_data.py` → company-industry mappings

### Downstream

- `InMemoryGraphStore` → stores loaded nodes and edges
- `agent/agents.py` → `GraphRetrieverAgent` explores `InMemoryGraphStore`
- `main.py` → uses `save_graph()` / `load_graph()` for JSON serialization

### External Dependencies

- `Neo4jConfig` (`config/settings.py`): `precedes_max_lag_days=30`, `batch_size=500`

---

## 5. Position in the Data Flow

```text
[Event Canonicalizer] + [Entity Resolver] + [CanonicalDocument]
              │
              ▼
[GraphPayloadBuilder.build()]   ← This document
              │  GraphPayload
              ▼
[InMemoryGraphStore.load_payload()]
              │
              ├──→ update nodes Dict
              ├──→ update edges List
              └──→ update passage_index
                         │
                         ▼
              [AgentOrchestrator] (STEP 4)
```

---

## 6. Implementation Design Standards

### Idempotency, `MERGE` Behavior

If the same `node_id` already exists, update its properties. Otherwise create a new node. Calling `load_payload(payload, replace=False)` merges into the existing graph.

```python
def load_payload(self, payload: GraphPayload, replace: bool = False):
    if replace:
        self.nodes = {}
        self.edges = []
    for node in payload.nodes:
        self.nodes[node.node_id] = node   # overwrite gives MERGE-like behavior
    self.edges.extend(payload.edges)
```

### KG Save / Load

```python
pipeline.save_graph(path)   # serialize to JSON → save file
pipeline.load_graph(path)   # load file → restore InMemoryGraphStore
```

This is used when restarting directly from agent initialization, STEP 4, without rerunning STEP 1 through STEP 3.

### Real-Time Supplemental Merge

`main.py` calls this with `replace=False` from `_online_supplement()`, which appends new nodes and edges into the existing KG.

---

## 7. Design Rationale

**Why include `PassageIndex` inside `GraphPayload` instead of keeping it outside the graph?**  
`PassageIndex` is the key index the agent uses to retrieve source text from event nodes. When it is included in `GraphPayload`, `save_graph()` and `load_graph()` serialize it together with the graph, so source recovery still works immediately after restart.

**Why not generate `PRECEDES` edges indiscriminately?**  
If every event pair is connected only by time order, the number of edges becomes `O(N²)` and exploration cost grows quickly. Restricting generation to the same Company and within 30 days keeps only the most plausible event chains and makes timeline exploration more efficient for the agent.
