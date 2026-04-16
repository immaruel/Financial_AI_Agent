# 01. Offline Pipeline

## 1. Purpose

The offline pipeline is a continuously running background process that collects documents from external sources and keeps the KG updated. It builds the data foundation that the online agent pipeline explores.

From a harness engineering perspective, the offline pipeline has two goals:

- **build the data substrate reliably**
- **make it possible to localize which stage broke quality**

In other words, the offline pipeline is not just ETL. It is a **verifiable production line** that supports downstream agent quality.

---

## 2. Harness-Aware Execution Flow

`run_full_pipeline()` in `main.py` executes the full offline pipeline sequentially. From the harness perspective, the end-to-end flow is:

```text
[Initialization]
FinancialKGPipeline.__init__()
  - initialize ReferenceDataManager
  - create collection / preprocessing / graph module instances
  - load the LLM model

        │
        ▼
[STEP 1] Collection
  DART / Naver collection
  -> normalization
  -> document deduplication / canonicalization
        │
        ├─ Verify:
        │   coverage, freshness, parsing_success, duplicate_rate
        │
        ▼
[STEP 2] Preprocessing
  sentence splitting
  -> NER
  -> Entity Typing
  -> Entity Resolution
  -> Event Extraction
  -> Event Canonicalization
        │
        ├─ Verify:
        │   ner/entity/event quality, event time consistency
        │
        ▼
[STEP 3] Graph Build
  build GraphPayload
  -> load into InMemoryGraphStore
        │
        ├─ Verify:
        │   schema validity, ontology constraint, orphan ratio,
        │   event-to-evidence linkage
        │
        ▼
[STEP 4] Agent Init
  build entity_dict
  -> initialize AgentOrchestrator
        │
        ▼
[Offline Registry]
  save trace
  summarize metrics
  evaluate regression gate
```

---

## 3. Stage-by-Stage Flow in the Current Implementation

### 3.1 Initialization

Work performed in `FinancialKGPipeline.__init__()`:

```python
asyncio.get_event_loop().run_until_complete(
    self.ref_data.load_from_dart(self.config.collection.dart_api_key)
)

self.llm_client = create_llm_client(self.config.llm, use_mock=use_mock_llm)
self.llm_client.load_model()
```

Reference entities and the model must be ready during initialization so later stages can be compared under deterministic behavior.

### 3.2 STEP 1: Document Collection

- `CollectionOrchestrator.collect_all()`
- `RawDocumentNormalizer.normalize_batch()`
- `DocumentFingerprinter.process_batch()`

Output:

- `List[CanonicalDocument]`

Current checkpoint:

- `checkpoints/step1_canonical_docs.json`

### 3.3 STEP 2: Preprocessing

- `DocumentPreprocessor.preprocess_batch()`
- `NERExtractor.extract_batch()`
- `EntityTypeClassifier.classify_batch()`
- `EntityResolver.resolve_batch()`
- `EventExtractor.extract()`
- `EventCanonicalizer.canonicalize()`

Output:

- `all_resolved_mentions`
- `event_candidates`
- `canonical_events`
- `canonical_docs`

In the current implementation, these outputs are not always persisted as separate files. Under a harness extension, it is preferable to add an explicit intermediate checkpoint such as `step2_output.json`.

### 3.4 STEP 3: KG Loading

- `GraphPayloadBuilder.build()`
- `InMemoryGraphStore.load_payload()`

Output:

- `GraphPayload`
- updated `graph_store`

Current checkpoint:

- `graph_store.json`

Under a harness extension, storing the raw `GraphPayload` as something like `step3_graph_output.json` is also recommended.

### 3.5 STEP 4: Agent Initialization

- build the entity dictionary
- prepare `AgentOrchestrator`

This stage is less about model quality improvement and more about verifying **execution readiness**.

---

## 4. Success and Failure Conditions by Stage

| Stage | Success condition | Failure condition |
|------|-------------------|------------------|
| STEP 1 collection | key filings and news are collected within freshness bounds and can be parsed | collection miss, API failure, parse failure, duplicate explosion |
| STEP 1 canonicalization | identical and corrected documents are grouped correctly | over-merging different docs, failed update-document linkage |
| STEP 2 entity/event | entities, times, numbers, and roles are structured correctly | alias failure, event-role error, missing event time |
| STEP 3 graph build | nodes and edges are connected under ontology constraints | orphan nodes, stale edges, too many events without evidence |
| STEP 4 agent init | `entity_dict` and graph state are synchronized | referencing stale KG, missing entity alias |

---

## 5. Offline Verification Layer

The core validation items in the offline layer are:

### 5.1 Document Collection / Canonicalization

- `ingestion_coverage`
- `freshness_lag_minutes`
- `parsing_success_rate`
- `duplicate_rate`
- `dedup_group_purity`
- `canonical_link_accuracy`

Key questions:

- Did important filings and news arrive on time?
- Were correction filings and updated articles linked correctly as parent-child?
- Was the same event left as too many canonical documents?

### 5.2 Entity / Event Extraction

- `ner_f1`
- `entity_link_acc`
- `alias_resolution_acc`
- `event_detection_f1`
- `event_argument_f1`
- `event_time_acc`

Key questions:

- Are forms like `Hyundai Motor`, `Hyundai Motor Company`, ticker, and corp code being grouped as the same entity?
- Are money amounts, ratios, dates, and target companies extracted accurately?
- Are there cases where the trigger is correct but subject and object are swapped?

### 5.3 Graph Loading

- `node_edge_schema_validity`
- `ontology_violation_count`
- `orphan_event_ratio`
- `event_to_evidence_link_rate`
- `graph_update_latency`

Key questions:

- Was the graph loaded without broken connections?
- Are there too many events without evidence?
- Are recent events being lost because of stale-edge policy?

---

## 6. Constraint Layer

The offline pipeline also needs explicit constraints.

| Constraint | Description |
|-----------|-------------|
| collectors use only allowed APIs and allowed lookback ranges | prevents unexpected data explosion |
| KG is not updated directly before canonicalization | prevents raw noisy data from entering the graph |
| only `GraphPayloadBuilder` may generate graph schema | forbids arbitrary node or edge creation by modules |
| stop loading when schema validation fails | prevents bad payloads from spreading |

---

## 7. Feedback Loop Layer

Failures in the offline layer should be recovered through the following loop.

### 7.1 Automatic Recovery

- retry on API timeout or temporary connector failure
- downgrade to title-only minimal documents when article-body fetch fails
- quarantine a source if parsing-failure rate rises
- save payload and stop loading when graph validation fails

### 7.2 Analysis and Improvement

Failures should preferably be stored with:

- failure stage
- affected document IDs
- failure taxonomy code
- config snapshot
- whether retry was performed
- repair action

The later improvement loop should follow this order:

1. run the baseline
2. inspect stage metrics
3. identify top issues by failure taxonomy
4. fix one bottleneck
5. rerun the same evaluation set
6. approve or roll back based on regression status

---

## 8. Drift / Cleanup / Entropy Management

Entropy accumulates over time in offline systems. If left unmanaged, retrieval and reasoning quality gradually degrades.

Recommended operational strategies:

- monitor drift in new aliases and new event expressions
- track failure rates in linking corrections and follow-up documents
- manage TTL for old checkpoints and traces
- clean obsolete graph snapshots
- keep a migration log whenever ontology changes so new runs remain comparable to older ones

---

## 9. CI/CD Gates and Regression Tests

The offline pipeline should ideally have two kinds of gates.

### 9.1 Smoke Gate

Fast verification with a small document set.

- whether connectors run
- whether schema serialization works
- whether graph payload generation works
- whether critical exceptions occur

### 9.2 Regression Gate

Quality comparison using gold evaluation assets or fixed sample sets.

- sharp drop in `entity_link_acc`
- sharp drop in `event_time_acc`
- rise in `ontology_violation_count`
- drop in `event_to_evidence_link_rate`

Examples of hard gates:

- schema validation failure
- ontology violation occurs
- orphan ratio spikes

Examples of soft gates:

- freshness worsens
- slight drop in event extraction quality
- increased latency

---

## 10. Design Rationale

**Why separate each STEP into its own method?**  
To support independent stage execution. If STEP 2 logic changes, there is no need to rerun STEP 1 collection. Checkpoint-based stage replay shortens the development and debugging cycle substantially.

**Why is a harness needed even in the offline stage?**  
A large part of online answer quality is determined by the quality of the data substrate before retrieval even begins. If offline metrics are poor, no amount of reasoning improvement will fix the system meaningfully.

**Why are intermediate checkpoints important?**  
They are essential for failure localization and regression comparison. STEP 2 and STEP 3 outputs must remain available so the team can distinguish whether extraction failed or graph loading failed.
