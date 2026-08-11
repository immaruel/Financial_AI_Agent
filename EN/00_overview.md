# 00. System Overview

> KPI extraction, backfill, and KPI time-series revision management are intentionally out of scope for this system.

---

## 1. Project Background and Motivation

The general capabilities of recent foundation models have improved rapidly. However, in domains like finance, where accuracy, relationship understanding, and freshness are critical, model performance alone is not enough to guarantee stable, high-quality answers.

In particular, a simple text-search-based RAG architecture has the following limitations.

- **It cannot explicitly represent relations between objects**: If multi-step connections such as company-subsidiary-supply chain-regulation are passed in as text chunks, the LLM must rely too heavily on inference to recover those relationships.
- **Context pollution**: Unrelated information can be retrieved together with relevant documents, making answer quality unstable.
- **Limited multi-hop reasoning**: It is not well suited to multi-step questions such as "through which industries and companies does this policy have an impact?"
- **Rising operational complexity**: As the pipeline becomes more complex, improvement slows down sharply if we cannot localize where failures occur.

To address this, we manage textual information not as plain documents but as structured knowledge, and we design and implement a harness engineering layer alongside it so the AI agent can operate reliably without human intervention in the common case.

```
1. Define the core objects and relations in the financial domain as an ontology.
2. Extract entities and events from filings and news to build a knowledge graph (KG).
3. Structure the user query into a QuerySpec, and select graph / lexical / vector / document-block
   retrieval channels based on the evidence the question actually requires.
4. Fuse and rerank the selected channels' results into a common EvidenceBlock unit to build the LLM
   input context.
5. The LLM produces only atomic claims constrained to evidence IDs; a deterministic verifier and
   Answer Gate check each claim's citation, numbers, time, and attribution.
6. On verification failure, a Critic/Supervisor performs a bounded, cause-specific retry or replan;
   if evidence is still insufficient, the system surfaces uncertainty or stops.
7. Every stage is monitored by the Constraint / Context / Verification / Feedback Loop harness.
```

This approach is expected to deliver higher accuracy and more consistent responses than standard RAG for relation understanding, multi-hop reasoning, and condition-based queries. Finance is a good fit for validating graph-based retrieval because it contains clearly defined entities and relations such as companies, products, transactions, and events.

---

## 2. System Goals

This project defines its goals across two layers.

### 2.1 Product Goal

> **Structure financial events such as industries, themes, company information, news, and filings into an ontology-based knowledge graph, and design and implement an Agentic GraphRAG pipeline that selects, verifies, and recovers retrieval paths per query.**

### 2.2 Harness Goal

> **Design an operational harness so that the AI agent can stably handle most financial queries without human intervention, while requesting limited human review only in high-risk, low-confidence, or system-failure scenarios.**

In other words, this document covers not only "what to build," but also "how to validate it, trace failures, and prevent regressions."

---

## 3. Problem Definition

| Item | Description |
|------|-------------|
| Problem to solve | Provide reliable question answering by structuring financial filings, news, and relationship information |
| Input data types | DART filings, news articles, reference entity data, user natural-language queries |
| Output requirements | Evidence-grounded answers, clickable citations, timeline, related companies, risk warning, confidence |
| Risks on failure | Company confusion, temporal mismatch, numeric/unit errors, exaggerated causality, unsupported forecasts, investment-advice-like phrasing |

In finance, the following matter more than simple answer accuracy.

- Whether the answer matches the actual evidence
- Whether the temporal axis is correct
- Whether aliases for the same company were resolved correctly, for example `Hyundai Motor Company` vs. `Hyundai Motor`
- Whether event causality was overstated
- Whether investment-advice-like expressions were properly controlled

Because of this, the system evaluates **offline KG construction quality** and **online Agentic GraphRAG quality** separately, and maintains a structure that supports **failure localization**.

---

## 4. Query Types the System Must Handle

The financial queries handled by this system are defined in four categories.

### 4.1 Fact Lookup

Fact-based questions about a specific company or industry.

- "What recent events happened to Hyundai Motor?"
- "Which news articles or filings connect to which industries or themes?"

### 4.2 Relationship Reasoning

Questions that explore structural relationships between entities across multiple steps.

- "Which groups of companies could this event propagate to?"
- "What are the supply chain, competitive, and policy beneficiary/victim relationships?"

### 4.3 Temporal Tracking

Questions that track temporal chains and patterns of events.

- "Which event happened first, and what followed from it in sequence?"
- "What patterns did similar past events show?"

### 4.4 Decision Support

Higher-level questions that require composite analysis.

- "What are the key catalysts in the market right now?"
- "Which groups of stocks should be monitored first?"

---

## 5. Design Considerations

The following ten principles cut across the full system design.

| # | Principle | Description |
|---|-----------|-------------|
| 1 | **Reliability-centered information structure** | Quantify source quality as a hierarchy: filings (grade 1) > IR (grade 2) > news (grade 3) > analysis (grade 4) > rumors (grade 5) |
| 2 | **Relationship-centered data modeling** | Structure industries, companies, events, and regulations around relations so that cross-data context is preserved as graph edges |
| 3 | **Separation of the graph from source evidence** | The graph is a tool for finding relationship candidates; the final factual evidence is always the original-text EvidenceBlock |
| 4 | **Rule system for large-scale data** | Clearly define trigger dictionaries, entity classes, and event hierarchies in advance |
| 5 | **JSON-based stage output management** | Support independent re-execution of each stage through Pydantic-schema serialization and checkpoint persistence |
| 6 | **Asynchronous and parallel execution** | Run external API calls asynchronously and independent retrieval workers in parallel; every worker always returns a success/partial/failure contract |
| 7 | **Stage-level parameter tuning** | Use `PipelineConfig` to make root-cause tracing and threshold tuning easier |
| 8 | **Clear tool boundaries** | Separate collection, extraction, graph construction, retrieval policy, answer generation, verification, and risk control so responsibilities do not overlap |
| 9 | **Boundary between deterministic and generative processing** | Reproducible decisions (schema validation, retrieval/fusion, numeric/temporal computation) are fixed in code; the LLM is used only for interpretation and bounded judgment |
| 10 | **Built-in feedback loop** | Collect failures through trace, metrics, and a failure taxonomy, and include an operational structure for iterative improvement |

---

## 6. Harness System Architecture

The harness is defined as four layers.

| Layer | Purpose | Role in the financial AI agent |
|-------|---------|--------------------------------|
| Constraint Layer | Define agent behavior boundaries | Prohibit investment advice, prohibit unsupported causal claims, restrict allowed tools/edge types/retry budget |
| Context Layer | Structure the reference information that must always be consulted | ontology, schema, prompt bundle, eval slice, failure taxonomy, context files |
| Verification Layer | Output validation and automated evaluation | schema validation, evidence sufficiency, per-claim citation/numeric/temporal/attribution verification, Answer Gate |
| Feedback Loop Layer | Root-cause analysis and self-repair after failures | worker failure code → Critic diagnosis → Supervisor's bounded retry/replan, trace-based bottleneck analysis, regression detection |

These four layers apply consistently to both the offline and online pipelines. In the online layer they are split between the `agent/` package (most of Constraint and Verification) and `harness/runtime.py` (Feedback Loop, trace, and gating).

---

## 7. Dual-Pipeline Structure

The system is divided into two layers, an **offline pipeline** and an **online pipeline**, each accompanied by a verification, regression, and feedback harness.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                    OFFLINE PIPELINE (always running)                 │
│                                                                      │
│  [STEP 1] Document collection                                        │
│   DART / Naver API -> RawDocument -> CanonicalDocument               │
│                                                                      │
│  [STEP 2] Document preprocessing                                     │
│   Sentence splitting -> NER -> Type classification -> Entity Resolution│
│   -> Event extraction -> Event Canonicalization                      │
│                                                                      │
│  [STEP 3] KG loading                                                 │
│   GraphPayloadBuilder -> InMemoryGraphStore -> PassageIndex          │
│                                                                      │
│  [Offline Verification]                                              │
│   coverage / dedup / entity / event / graph validity                │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│           ONLINE PIPELINE (run per query, agent/orchestrator.py)     │
│                                                                      │
│  User query + user_id + request_timestamp                            │
│   -> Query Understanding Agent (LLM) -> deterministic validation/    │
│      entity resolution                                               │
│   -> Retrieval Policy Builder (deterministic) -> memory/graph/hybrid/│
│      document-block workers run in parallel -> Evidence Fusion(RRF)  │
│      + Rerank                                                        │
│   -> Evidence Requirement Gate -> Claim-first Generator (LLM)        │
│   -> Deterministic Verifier (numeric/temporal/attribution/relation)  │
│      -> Answer Gate                                                  │
│   -> Critic/Supervisor bounded retry -> Risk warnings -> StructuredAnswer│
│                                                                      │
│  [Online Verification]                                               │
│   per-claim citation/numeric/temporal/attribution checks, Answer     │
│   Gate, harness F1-F8 post-check, human_review_required decision     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        HARNESS SIDE-CAR LAYERS                       │
│                                                                      │
│  Constraint  |  Context  |  Verification  |  Feedback Loop           │
│  CI/CD Gate  |  Trace    |  Metrics       |  Experiment Registry     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. End-to-End Data Flow

```text
External APIs (DART / Naver)
      │
      ▼
RawDocument                    ← collection/source_connector.py
      │  normalization + deduplication
      ▼
CanonicalDocument              ← collection/raw_normalizer.py
                               ← collection/document_fingerprint.py
      │  sentence splitting + subtype classification
      ▼
PreprocessedDocument           ← preprocessing/doc_preprocessor.py
      │  dictionary/rule/trigger-based extraction
      ▼
MentionSpan                    ← preprocessing/ner_extractor.py
      │  type confirmation and normalization
      ▼
TypedMention                   ← preprocessing/entity_type_classifier.py
      ▼
ResolvedMention                ← preprocessing/entity_resolver.py
      │  Event Frame generation
      ▼
EventCandidate                 ← preprocessing/event_extractor.py
      │  duplicate merging
      ▼
CanonicalEvent                 ← preprocessing/event_canonicalizer.py
      │  node/edge/PassageIndex conversion
      ▼
GraphPayload                   ← ontology/graph_loader.py
      ▼
InMemoryGraphStore              ← ontology/graph_loader.py
      │  (per query) Query Understanding -> Retrieval Policy -> worker execution
      │  -> Evidence Fusion -> claim generation/verification -> Answer Gate
      ▼
StructuredAnswer                ← agent/orchestrator.py
```

From the harness perspective, it is important to leave the following trace at every stage of this flow.

- Input/output schema version
- confidence / score
- IDs of the documents, nodes, and evidence used
- Failure cause and recovery action
- latency / cost / retry count

---

## 9. Failure Taxonomy and Human Intervention Criteria

### 9.1 Finance-Specific Failure Taxonomy

| Code | Error type | Example |
|------|------------|---------|
| F1 | Entity confusion | Confusing the target with another company, ticker mismatch, subsidiary/headquarters confusion |
| F2 | Temporal error | Using outdated information instead of the latest, confusing announcement date with effective date |
| F3 | Numeric error | Errors in amount/ratio/unit, confusing absolute values with change rates |
| F4 | Event attribution error | Swapping the acting company and the affected company |
| F5 | Missing evidence | Missing key citations, missing counter-evidence |
| F6 | Overstated reasoning | Treating correlation as causation, presenting possibility as fact |
| F7 | Safety error | Investment advice, excessive certainty, missing risk warnings |
| F8 | Over-defensiveness | Avoiding questions the system could actually answer |

### 9.2 Human-in-the-Loop Trigger Conditions

Human intervention is allowed only in the following situations.

- high-risk decision
- low-confidence output
- system failure

More concretely, an item is routed to human review when at least one of the following conditions is met.

- entity ambiguity exceeds the threshold (routed to clarification with status `entity_ambiguous`)
- evidence supporting the core claim is insufficient (blocked by the Evidence Requirement Gate / Answer Gate)
- numeric/temporal validation fails
- the risk controller detects high-risk investment phrasing
- the Supervisor's retry limit for the same failure is exceeded (`RETRY_BUDGET_EXHAUSTED`)

---

## 10. Trace Management and Evaluation Framework

### 10.1 Trajectory Management

To prevent the system from degrading over time, we adopt the following operational rules.

- **Manage data drift**: Regularly collect new aliases, new event expressions, and new policy keywords
- **Rule update method**: When rules change, record the prompt/version/config snapshot together
- **Automatic cleanup strategy**: Compress old traces, manage TTLs for experiment artifacts, remove stale cache
- **Prioritize corrections and follow-up documents**: Link correction filings, updated articles, and follow-up reports to the latest truth state

### 10.2 Evaluation Framework

The harness uses the following six axes as its default evaluation metrics.

- Accuracy
- Faithfulness
- Consistency
- Latency
- Cost
- Safety / Compliance

Detailed metrics are defined separately by stage in the offline and online documents.

---

## 11. Related Documents

| Topic | Document |
|------|----------|
| End-to-end agent architecture, execution loop, contracts, ledger | [04_agent_system/01_agent_architecture.md](04_agent_system/01_agent_architecture.md) |
| Query Understanding and Retrieval Policy | [04_agent_system/02_query_understanding_and_routing.md](04_agent_system/02_query_understanding_and_routing.md) |
| Graph/Hybrid/Document-block retrieval workers | [04_agent_system/03_retrieval_workers.md](04_agent_system/03_retrieval_workers.md) |
| EvidenceBlock and claim-first generation | [04_agent_system/04_evidence_and_claims.md](04_agent_system/04_evidence_and_claims.md) |
| Deterministic claim verifier and Answer Gate | [04_agent_system/05_verification_and_answer_gate.md](04_agent_system/05_verification_and_answer_gate.md) |
| Critic/Supervisor recovery, user memory, risk management | [04_agent_system/06_recovery_memory_and_harness.md](04_agent_system/06_recovery_memory_and_harness.md) |
| Full parameter specification and harness extension management items | [05_config_and_schemas/01_pipeline_config.md](05_config_and_schemas/01_pipeline_config.md) |
| Data schemas and trace / eval schema | [05_config_and_schemas/02_data_schemas.md](05_config_and_schemas/02_data_schemas.md) |
| Offline execution flow and verification points | [06_pipeline_runtime/01_offline_pipeline.md](06_pipeline_runtime/01_offline_pipeline.md) |
| Online query handling and self-repair / HITL | [06_pipeline_runtime/02_online_query_pipeline.md](06_pipeline_runtime/02_online_query_pipeline.md) |
