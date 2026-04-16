# 03. Graph Retriever Agent

## 1. Purpose

Accept `QueryPlan`, explore the KG for the relevant subgraph, and return `SubGraphResult`. Processing runs in the order of seed discovery → intent-based hop selection → BFS-based subgraph expansion → temporal filtering → size truncation.

The output of this module becomes the core graph context fed into the LLM.

From a harness engineering perspective, Graph Retriever is the **critical boundary that separates "we failed to bring back the needed graph" from "we brought it back but later stages failed to use it."** For that reason, retrieval quality must be evaluated separately from reasoning quality.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `QueryPlan` | Query intent, entity phrases, time constraints |
| `InMemoryGraphStore` | KG to be explored |
| `AgentConfig` | Hop settings, maximum subgraph size, edge-confidence threshold |

### Output

`SubGraphResult` (`utils/schemas.py`)

| Field | Type | Description |
|------|------|-------------|
| `seed_nodes` | List[str] | Starting node IDs for exploration |
| `nodes` | List[Dict] | Retrieved nodes with properties |
| `edges` | List[Dict] | Retrieved edges |
| `hop_depth` | int | Actual hop depth used |
| `retrieval_method` | str | `"hybrid"` |

---

## 3. Processing Logic

### 3.1 Seed Node Discovery

Use a three-step fallback strategy.

```text
Step 1: direct match through entity_phrases, based on entity_dict
  → if entity_id from plan.entity_phrases exists in the graph, use it immediately

Step 2: partial-string matching with raw_phrases
  → phrase contained in node.properties["name"] or vice versa
  → expensive because it scans all graph nodes

Step 3: fuzzy matching, only if Steps 1 and 2 found no seeds
  → rapidfuzz.fuzz.partial_ratio(phrase, node_name) >= 80
  → log successful matches
```

```python
if not seed_ids:
    from rapidfuzz import fuzz
    for phrase in all_phrases:
        for node in self.graph.nodes.values():
            score = fuzz.partial_ratio(phrase, node.properties.get("name", ""))
            if score >= 80:
                seed_ids.append(node.node_id)
```

### 3.2 Intent-Based Hop Count

```python
hop_by_intent = {
    "event_summary":   2,
    "fact_lookup":     2,
    "impact_analysis": 3,
    "comparison":      2,
}
max_hops = hop_by_intent.get(plan.primary_intent, 2)
```

### 3.3 Intent-Based Allowed Edge Types

Only follow edge types in the list associated with the intent.

| Intent | Allowed edges |
|--------|---------------|
| `event_summary` | HAS_EVENT, HAS_EVENT_CANDIDATE, CANONICALIZED_TO, SUPPORTED_BY, FROM_DOCUMENT, DISCLOSED_IN, REPORTED_IN, OBSERVED_IN, PRECEDES |
| `impact_analysis` | HAS_EVENT, HAS_EVENT_CANDIDATE, INVOLVES, AFFECTS, CAUSED_BY, PRECEDES, SUPPORTED_BY, FROM_DOCUMENT |
| `fact_lookup` | HAS_EVENT, HAS_EVENT_CANDIDATE, SUPPORTED_BY, FROM_DOCUMENT, DISCLOSED_IN, REPORTED_IN, OBSERVED_IN |
| `company_screening` | BELONGS_TO_INDUSTRY, HAS_EVENT, HAS_EVENT_CANDIDATE |
| default | HAS_EVENT, HAS_EVENT_CANDIDATE, CANONICALIZED_TO, SUPPORTED_BY, FROM_DOCUMENT |

### 3.4 BFS-Based Subgraph Exploration

Call `InMemoryGraphStore.get_subgraph()`.

```python
subgraph = self.graph.get_subgraph(
    seed_ids=seed_ids,
    max_hops=max_hops,
    min_confidence=self.config.min_edge_confidence,  # default: 0.60
    edge_types=edge_types,
)
```

`min_edge_confidence` excludes low-confidence edges from traversal.

### 3.5 Temporal Filtering

If `time_constraints["window_days"]` is set, filter Event nodes by `event_time` and remove events outside the window.

```python
cutoff = datetime.now(KST) - timedelta(days=window_days)
filtered_nodes = [
    node for node in subgraph.nodes
    if node.label != "Event" or (
        node.properties.get("event_time") and
        datetime.fromisoformat(node.properties["event_time"]) >= cutoff
    )
]
```

After filtering, also remove dangling edges whose endpoints no longer both exist.

### 3.6 Subgraph Size Limit

If the node count exceeds `max_subgraph_nodes(50)`, apply **relevance-based truncation** via `_truncate_subgraph_safe()`.

**Node relevance scoring:**

| Node type | Base score | Description |
|-----------|------------|-------------|
| Seed Node | 10 | company or entity node matched directly through `entity_dict` |
| Primary Event | 7 | `HAS_EVENT` target directly connected to the seed |
| 1-hop Node | 4 | node reached within one step from the seed |
| 2-hop or farther Node | 2 | node beyond one hop |

If the connecting edge has a confidence property, use `base_score × confidence` as the final score. Keep only the top 50 nodes and remove all edges connected to discarded nodes.

---

## 4. Dependencies and Connected Modules

### Upstream

- `QueryPlannerAgent` → `QueryPlan`
- `InMemoryGraphStore` (`ontology/graph_loader.py`)
- `AgentConfig` (`config/settings.py`)

### Downstream

- `EvidenceRetrieverAgent` → receives `SubGraphResult`
- `CausalReasonerAgent` → receives `SubGraphResult`
- `AnswerComposerAgent` → receives `SubGraphResult`, for LLM context construction

### External Dependencies

- `rapidfuzz`: fuzzy seed discovery

---

## 5. Position in the Data Flow

Agent pipeline **Step 2 / 7**. It accepts `QueryPlan`, explores the KG, and passes `SubGraphResult` to downstream agents as shared context.

```text
[QueryPlannerAgent]  (Step 1 / 7)
        │  QueryPlan
        ▼
[GraphRetrieverAgent]   ← This document (Step 2 / 7)
        │  SubGraphResult
        ├──→ [EvidenceRetrieverAgent]
        ├──→ [CausalReasonerAgent]
        └──→ [AnswerComposerAgent]
```

---

## 6. Verification Points from the Harness Perspective

Graph Retriever should be measured separately on the following.

| Item | Meaning |
|------|---------|
| `seed_precision` / `seed_recall` | whether the correct starting nodes were found from planner entities and raw phrases |
| `subgraph_recall@k` | whether the key events, companies, and documents needed for the answer were included |
| `irrelevant_node_ratio` | whether noise nodes were included excessively |
| `temporal_filter_accuracy` | whether outdated events were correctly filtered out for time-bound queries |
| `edge-type coverage` | whether edge types required by the query intent were included |

Retrieval trace should include:

- seed node IDs
- seed discovery method, exact / partial / fuzzy
- hop count
- allowed edge type list
- node counts before and after pruning
- temporal filter results

Representative failure types:

- F1 entity confusion
- F2 temporal error
- upstream causes of F5 missing evidence

---

## 7. Implementation Design Standards

### Internal `get_subgraph` Behavior

```python
def get_subgraph(self, seed_ids, max_hops, min_confidence, edge_types):
    visited = set(seed_ids)
    frontier = set(seed_ids)

    for hop in range(max_hops):
        next_frontier = set()
        for edge in self.edges:
            if edge.edge_type not in edge_types:
                continue
            conf = edge.properties.get("confidence", 1.0)
            if conf < min_confidence:
                continue
            if edge.source_id in frontier and edge.target_id not in visited:
                next_frontier.add(edge.target_id)
                visited.add(edge.target_id)
        frontier = next_frontier

    result_nodes = [self.nodes[nid] for nid in visited if nid in self.nodes]
    result_edges = [
        e for e in self.edges
        if e.source_id in visited and e.target_id in visited
        and e.edge_type in edge_types
    ]
    return GraphPayload(nodes=result_nodes, edges=result_edges)
```

### `SubGraphResult` Node Structure

Each item in `SubGraphResult.nodes` is flattened into the form `{"id": node_id, "label": label, **properties}` so Answer Composer can build LLM prompts more easily.

---

## 8. Design Rationale

**Why vary allowed edge types by intent?**  
If an `event_summary` query follows `CAUSED_BY`, it may include unwanted causal chains. By contrast, `impact_analysis` depends heavily on `CAUSED_BY` and `AFFECTS`. Intent-specific edge filtering reduces noise in the subgraph and improves the relevance of LLM context.

**Why keep fuzzy matching as the last fallback?**  
Fuzzy matching scans all graph nodes and therefore incurs cost proportional to graph size. Exact matching and partial-string matching already provide strong coverage, so fuzzy matching is used only when both earlier methods fail.
