# 02. Graph Schema

## 1. Purpose

Turn the ontology definition into a concrete structure for Neo4j and `InMemoryGraphStore`. This document specifies required properties, unique keys, load conditions, and skip conditions for each node and edge type.

---

## 2. Node Schemas

### Company

```text
Label:      Company
Unique Key: canonical_entity_id
```

| Attribute | Required | Type | Description |
|-----------|----------|------|-------------|
| `canonical_entity_id` | ✓ | str | Unique key across the full system |
| `name` | ✓ | str | Official company name |
| `ticker` | | str | Ticker symbol |
| `corp_code` | | str | DART corporation code |
| `exchange` | | str | Listing exchange |
| `country` | | str | Country of registration |
| `status` | | str | `active` / `delisted` |
| `created_at` | | datetime | First creation time |
| `updated_at` | | datetime | Last update time |

**Load conditions:**

- `entity_type == "Company"` and `canonical_entity_id` exists
- normalization completed through reference data or alias resolution

**Skip conditions:**

- unresolved mention, `resolution_status != "resolved"`
- generic placeholder company

**Update method:** `MERGE` by `canonical_entity_id`, then `SET` latest values

---

### Industry

```text
Label:      Industry
Unique Key: industry_id
```

| Attribute | Required | Type | Description |
|-----------|----------|------|-------------|
| `industry_id` | ✓ | str | Industry classification ID |
| `name` | ✓ | str | Industry name |
| `taxonomy_source` | | str | Taxonomy source |
| `status` | | str | |
| `created_at` | | datetime | |
| `updated_at` | | datetime | |

**Load condition:** reference-data-based mapping exists  
**Skip condition:** industry inferred only from a single article context

---

### Event

```text
Label:      Event
Unique Key: canonical_event_id
```

| Attribute | Required | Type | Description |
|-----------|----------|------|-------------|
| `canonical_event_id` | ✓ | str | Unique event key |
| `event_type` | ✓ | str | Leaf event type |
| `event_time` | ✓ | datetime | Occurrence time |
| `event_subtype` | | str | Higher-level category |
| `effective_time` | | datetime | Effective time |
| `polarity` | | str | positive / negative / neutral / mixed |
| `certainty` | | str | disclosed / reported / estimated / speculated |
| `representative_source_type` | | str | Representative source type |
| `confidence` | | float | Extraction confidence |
| `trigger_text` | | str | Representative trigger expression |
| `status` | | str | `active` / `retracted` |
| `created_at` | | datetime | |
| `updated_at` | | datetime | |

**Load conditions:**

- `canonical_event_id` exists
- `event_type` exists
- `event_time` exists, or is backfilled from `published_at`
- `subject_entity_id` exists or at least one resolved related entity exists

**Skip conditions:**

- candidate-stage result rather than canonical event
- event identity still undecided
- `factuality = "rumor"` and `confidence < 0.5`

---

### EventCandidate, Intermediate Node

```text
Label:      EventCandidate
Unique Key: event_candidate_id
```

Keep pre-canonicalization event candidates in the graph. They connect to `CanonicalEvent` through `CANONICALIZED_TO` and are useful when the Evidence Retriever needs to examine document-level evidence directly.

---

### Document

```text
Label:      Document
Unique Key: canonical_doc_id
```

| Attribute | Required | Type | Description |
|-----------|----------|------|-------------|
| `canonical_doc_id` | ✓ | str | Unique document key |
| `source_type` | ✓ | str | `filing` / `news` |
| `title` | ✓ | str | Document title |
| `trust_tier` | | int | Source reliability, 1 through 5 |
| `published_at` | | datetime | |
| `updated_at` | | datetime | |
| `source_url` | | str | |
| `doc_status` | | str | `active` / `superseded` / `duplicate` |
| `created_at` | | datetime | |

---

### Evidence

```text
Label:      Evidence
Unique Key: evidence_id (SHA-1 based)
```

| Attribute | Required | Type | Description |
|-----------|----------|------|-------------|
| `evidence_id` | ✓ | str | Unique key |
| `text` | ✓ | str | Original text |
| `canonical_doc_id` | | str | Source document ID |
| `sentence_id` | | str | Source sentence ID |
| `char_start` / `char_end` | | int | Offsets |
| `extraction_method` | | str | Extraction method |
| `confidence` | | float | |
| `created_at` | | datetime | |

**Skip conditions:**

- sentence alignment failed, so `sentence_id` cannot be mapped
- span length exceeds `max_sentence_length`

---

### Region / Institution / Commodity

All follow the same minimal schema.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `{type}_id` | ✓ | Unique key |
| `name` | ✓ | Name |

---

## 3. Edge Schemas

### BELONGS_TO_INDUSTRY

```cypher
(:Company)-[:BELONGS_TO_INDUSTRY]->(:Industry)
```

| Attribute | Description |
|-----------|-------------|
| `source` | Mapping source |
| `confidence` | |
| `valid_from` | Effective start time |
| `updated_at` | |

**Creation condition:** Company node exists + Industry node exists + reference-data mapping exists  
**Forbidden condition:** inferred only from a single article context

---

### HAS_EVENT

```cypher
(:Company)-[:HAS_EVENT {role:"subject"}]->(:Event)
```

| Attribute | Description |
|-----------|-------------|
| `role` | Always `"subject"` |
| `confidence` | |
| `updated_at` | |

**Creation condition:** `canonical_event.subject_entity_id` is resolved to Company  
**Forbidden condition:** subject is unresolved or a generic placeholder

---

### INVOLVES

```cypher
(:Event)-[:INVOLVES]->(:Company|:Institution|:Region|:Commodity)
```

| Attribute | Description |
|-----------|-------------|
| `role` | `counterparty`, `regulator`, `region`, `commodity`, and so on |
| `confidence` | |
| `updated_at` | |

**Creation condition:** object or related slot exists in the event frame and that entity has been resolved  
**Forbidden condition:** unclear role or unresolved entity

---

### SUPPORTED_BY → FROM_DOCUMENT

```cypher
(:Event)-[:SUPPORTED_BY]->(:Evidence)-[:FROM_DOCUMENT]->(:Document)
```

Create this for every `EvidenceSpan` attached to an event. The agent's Evidence Retriever explores this path.

---

### PRECEDES

```cypher
(:Event1)-[:PRECEDES {lag_days: N}]->(:Event2)
```

| Attribute | Description |
|-----------|-------------|
| `lag_days` | Day-level time difference between the two events |
| `confidence` | |
| `updated_at` | |

**Creation conditions:**

- both nodes are canonical events
- same company or same event family
- `event_time(E1) < event_time(E2)`
- time difference ≤ `precedes_max_lag_days`, default 30 days in `Neo4jConfig`

**Forbidden condition:** blind generation based only on sorted timestamps

---

### CANONICALIZED_TO

```cypher
(:EventCandidate)-[:CANONICALIZED_TO]->(:Event)
```

Represents the result of Event Canonicalization in the graph. Multiple `EventCandidate` nodes can connect to a single `Event`.

---

## 4. `InMemoryGraphStore` Structure

Use an in-memory implementation from `graph_loader.py` rather than a live Neo4j instance.

```python
class InMemoryGraphStore:
    nodes: Dict[str, GraphNode]        # node_id → GraphNode
    edges: List[GraphEdge]             # full edge list
    passage_index: PassageIndex        # event → source passage index
```

The agent explores subgraphs through `get_subgraph(seed_ids, max_hops, min_confidence, edge_types)`.

### PassageIndex Structure

```python
class PassageIndex:
    documents: Dict[str, DocumentTextRecord]       # doc_id → document metadata
    passages: Dict[str, PassageRecord]             # passage_id → source text
    event_to_passage_ids: Dict[str, List[str]]     # event_id → list of passage_id
    event_candidate_to_passage_ids: ...
    document_to_passage_ids: ...
```

The agent's Evidence Retriever uses `event_to_passage_ids` to jump directly from an event to source passages.

---

## 5. Design Rationale

**Why use `InMemoryGraphStore` instead of Neo4j?**  
The current system is still in a local development and validation phase. `InMemoryGraphStore` already uses the same `GraphPayload` interface as Neo4j, so future integration only requires replacing `load_payload()`. Configuration for Neo4j is already present in `Neo4jConfig`, `bolt://localhost:7687`.

**Why keep both Event and EventCandidate as nodes?**  
Canonicalization is probabilistic and can over-merge. Keeping EventCandidate as a separate node makes it possible to re-validate evidence at the individual-document level or detect incorrect merges later.
