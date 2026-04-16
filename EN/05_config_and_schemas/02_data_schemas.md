# 02. Data Schemas

## 1. Purpose

Define the input and output data structures for each pipeline stage in `utils/schemas.py` using Pydantic v2 models. All inter-stage data is serialized and deserialized according to these schemas, and JSON checkpoint persistence also relies on this structure.

From a harness engineering perspective, additional schemas are also needed:

- trace schemas for recording intermediate execution outputs
- gold asset schemas for evaluation
- failure taxonomy and failure case schemas
- run metadata and experiment registry schemas

In other words, this document explains both the **core data schemas used by the current implementation** and the **operational schemas that should be managed when harness extensions are introduced**.

---

## 2. Schema Hierarchy

```text
[STEP 1: Collection]
RawDocument
  └→ CanonicalDocument

[STEP 2: Preprocessing]
CanonicalDocument
  └→ PreprocessedDocument (includes Sentence list)
       └→ MentionSpan
            └→ TypedMention
                 └→ ResolvedMention
                      └→ EventCandidate (includes EvidenceSpan and MoneyAmount)
                           └→ CanonicalEvent

[STEP 3: KG Loading]
ResolvedMention + CanonicalEvent + CanonicalDocument
  └→ GraphPayload (GraphNode + GraphEdge + PassageIndex)

[STEP 4: Agent]
QueryPlan
  └→ SubGraphResult
       └→ EvidenceResult
            └→ CausalChain
                 └→ StructuredAnswer

[HARNESS EXTENSION]
EvalSample
  └→ QueryTrace
       └→ RetrievalTrace
            └→ ReasoningTrace
                 └→ AnswerTrace
                      └→ FailureCase / RunRecord
```

---

## 3. Core Schemas in Detail

### `RawDocument`

One raw source document at collection time.

```python
class RawDocument(BaseModel):
    raw_doc_id: str
    source_type: SourceType
    source_url: str
    external_doc_id: str
    original_title: str
    raw_text: str
    original_timestamp: Optional[datetime]
    crawled_at: datetime
    first_seen_at: datetime
    rcept_no: Optional[str]
    corp_code: Optional[str]
    is_correction: bool = False
    parent_rcept_no: Optional[str]
```

### `CanonicalDocument`

Representative document after duplicate and version resolution.

```python
class CanonicalDocument(BaseModel):
    canonical_doc_id: str
    source_type: SourceType
    trust_tier: int
    title: str
    normalized_text: str
    published_at: Optional[datetime]
    doc_status: DocStatus
    parent_doc_id: Optional[str]
    dedup_group_id: Optional[str]
    document_class: str
```

### `PreprocessedDocument` / `Sentence`

```python
class PreprocessedDocument(BaseModel):
    canonical_doc_id: str
    source_type: SourceType
    title_text: str
    sentences: List[Sentence]
    doc_subtype: str
    published_at: Optional[datetime]

class Sentence(BaseModel):
    sentence_id: str
    text: str
    char_start: int
    char_end: int
```

### `ResolvedMention`

Mention after Entity Resolution.

```python
class ResolvedMention(BaseModel):
    mention_id: str
    mention_text: str
    sentence_id: str
    entity_type: str
    canonical_entity_id: str
    canonical_name: str
    resolution_method: str
    resolution_confidence: float
    resolution_status: ResolutionStatus
```

### `EventCandidate`

Event frame before canonicalization.

```python
class EventCandidate(BaseModel):
    event_candidate_id: str
    canonical_doc_id: str
    source_type: SourceType
    event_type: str
    subject_entity_id: str
    object_entity_id: str
    trigger_text: str
    amount: Optional[MoneyAmount]
    event_time: Optional[datetime]
    certainty: Certainty
    factuality: Factuality
    polarity: Polarity
    evidence: List[EvidenceSpan]
    confidence: float
    slots: Dict[str, Any]
```

### `CanonicalEvent`

Result of Event Canonicalization. Source object for Event nodes in the KG.

```python
class CanonicalEvent(BaseModel):
    canonical_event_id: str
    event_type: str
    subject_entity_id: str
    object_entity_id: str
    amount: Optional[float]
    event_time: Optional[datetime]
    polarity: Polarity
    certainty: Certainty
    source_event_candidate_ids: List[str]
    source_canonical_doc_ids: List[str]
    representative_source_type: str
    confidence: float
    evidence: List[EvidenceSpan]
```

### `GraphPayload`

Unit used for KG loading.

```python
class GraphPayload(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    passage_index: Optional[PassageIndex]
    seed_nodes: List[str]

class GraphNode(BaseModel):
    node_id: str
    label: str
    properties: Dict[str, Any]

class GraphEdge(BaseModel):
    source_id: str
    target_id: str
    edge_type: str
    properties: Dict[str, Any]
```

### `StructuredAnswer`

Final agent output.

```python
class StructuredAnswer(BaseModel):
    summary: str
    timeline: List[Dict[str, Any]]
    related_companies: List[str]
    impact_analysis: str
    counter_evidence: str
    confidence: float
    sources: List[Dict[str, str]]
    risk_warnings: List[str]
```

---

## 4. Harness Extension Schemas

The following schemas are not all fully implemented in the current code, but are recommended to be stored in separate files or registries when harness engineering is applied.

### 4.1 `EvalSample`

The basic unit of the evaluation set.

```python
class EvalSample(BaseModel):
    sample_id: str
    query: str
    intent: str
    target_entities: List[str]
    temporal_scope: Dict[str, str]
    expected_event_types: List[str]
    gold_seed_nodes: List[str]
    gold_evidence_ids: List[str]
    gold_answer_points: List[str]
    forbidden_claims: List[str]
    risk_label: str
```

### 4.2 `QueryTrace`

Observation record for the planner stage.

```python
class QueryTrace(BaseModel):
    run_id: str
    query: str
    normalized_query: str
    planner_output: Dict[str, Any]
    planner_confidence: Optional[float]
    risk_class: Optional[str]
```

### 4.3 `RetrievalTrace`

Trace for retrieval and evidence stages.

```python
class RetrievalTrace(BaseModel):
    run_id: str
    seed_nodes: List[str]
    retrieved_node_ids: List[str]
    retrieved_edge_ids: List[str]
    pruned_node_ids: List[str]
    evidence_ids: List[str]
    contradiction_evidence_ids: List[str]
    retrieval_scores: Dict[str, float]
```

### 4.4 `ReasoningTrace` / `AnswerTrace`

```python
class ReasoningTrace(BaseModel):
    run_id: str
    hypotheses: List[str]
    accepted_hypotheses: List[str]
    rejected_hypotheses: List[str]
    checker_verdict: Dict[str, Any]

class AnswerTrace(BaseModel):
    run_id: str
    final_answer: str
    cited_evidence_ids: List[str]
    confidence: float
    risk_flags: List[str]
    latency_ms: int
    token_cost: Optional[float]
```

### 4.5 `FailureCase`

Structure for storing failed cases according to the taxonomy.

```python
class FailureCase(BaseModel):
    run_id: str
    sample_id: str
    failure_code: str
    failure_stage: str
    root_cause: str
    severity: str
    trace_refs: List[str]
    repair_action: Optional[str]
```

### 4.6 `RunRecord`

Execution unit for experiment or regression runs.

```python
class RunRecord(BaseModel):
    run_id: str
    timestamp: datetime
    dataset_version: str
    ontology_version: str
    prompt_bundle_version: str
    config_snapshot: Dict[str, Any]
    aggregate_metrics: Dict[str, float]
    slice_metrics: Dict[str, Dict[str, float]]
    failure_cases: List[str]
```

---

## 5. Failure Taxonomy

The recommended failure taxonomy includes the following eight categories.

| Code | Meaning | Example |
|------|---------|---------|
| `F1` | entity confusion | confusion with another company, ticker mismatch |
| `F2` | temporal error | mixing old and latest information, confusing announcement date with effective date |
| `F3` | numeric error | amount, ratio, or unit error |
| `F4` | event attribution error | subject and target company swapped |
| `F5` | missing evidence | insufficient citation, missing counter-evidence |
| `F6` | overstated reasoning | treating correlation as causation |
| `F7` | safety error | investment advice, missing risk warning |
| `F8` | over-defensiveness | avoiding questions the system could answer |

This taxonomy should be stored together with trace so bottlenecks can be found quickly in the next improvement loop.

---

## 6. Enum Definitions

| Enum | Values | Usage |
|------|--------|-------|
| `SourceType` | filing, news, ir, analysis, government | full pipeline |
| `DocStatus` | active, superseded, retracted, duplicate | `CanonicalDocument` |
| `ResolutionStatus` | resolved, placeholder, unresolved | `ResolvedMention` |
| `Factuality` | fact, interpretation, rumor, unknown | `EventCandidate`, `CanonicalEvent` |
| `Certainty` | disclosed, reported, estimated, speculated | `EventCandidate`, `CanonicalEvent` |
| `Polarity` | positive, negative, neutral, mixed | `EventCandidate`, `CanonicalEvent` |

---

## 7. Design Rationale

**Why use Pydantic v2?**  
Pydantic v2 can serialize full schemas including `datetime` and `Enum` through `model_dump(mode="json")`. That removes the need for custom serialization logic when saving and loading checkpoints, such as `save_step1` and `save_graph`.

**Why use type-specific ID prefixes?**  
Prefixes such as `raw_`, `canon_`, `evt_cand_`, `canon_evt_`, `men_`, and `passage_` make it possible to identify an object's stage immediately just by looking at the ID in logs or traces. Plain UUIDs without prefixes are much harder to trace across the pipeline.

**Why keep trace / eval / run schemas separate?**  
Core schemas show what was created, but not why the outcome happened. In harness engineering, trace and run metadata are central to the improvement loop, so they should be managed explicitly as separate schema families.
