# Document Tree

## Design-to-Document Mapping

This document follows the structure below.

- Domain and problem definition, plus the overall architecture
- Offline data pipeline
- Preprocessing and entity/event extraction
- Ontology and graph loading
- Agentic GraphRAG
- Configuration / schemas / runtime
- Operational rules from a harness engineering perspective

In other words, the documents cover both "what was implemented" and "how it is operated and validated."

---

## Full Document Tree

```text
docs/
├── INDEX.md                                    ← This file
├── 00_overview.md                              ← Background / goals / problem definition / harness layers / dual pipeline
│
├── 01_data_pipeline/                           ← Document collection
│   ├── 01_ingestion.md                         ← Async DART/Naver collection, correction filing handling
│   └── 02_normalization.md                     ← Normalization, deduplication, checkpoints
│
├── 02_preprocessing/                           ← Document preprocessing
│   ├── 01_doc_preprocessor.md                  ← Sentence splitting, subtype classification
│   ├── 02_ner_extractor.md                     ← Dictionary / rule / trigger extraction with recall-first strategy
│   ├── 03_entity_type_classifier.md            ← Reference → Fuzzy → Rule → LLM type confirmation
│   ├── 04_entity_resolver.md                   ← canonical_entity_id resolution, placeholder handling
│   ├── 05_event_extractor.md                   ← Event Frame, factuality/certainty judgment
│   └── 06_event_canonicalizer.md               ← Event-level duplicate merging
│
├── 03_knowledge_graph/                         ← Ontology / graph loading
│   ├── 01_ontology.md                          ← Static / dynamic / evidence 3-layer model, entities/edges
│   ├── 02_graph_schema.md                      ← Node/edge schema, load/skip conditions
│   └── 03_graph_loader.md                      ← GraphPayloadBuilder, PassageIndex construction
│
├── 04_agent_system/                            ← Agentic GraphRAG (verifiable multi-agent orchestration)
│   ├── 01_agent_architecture.md                ← Full component set, execution loop, contracts, trace/ledger
│   ├── 02_query_understanding_and_routing.md   ← QuerySpec, NeedLevel, Retrieval Policy Builder
│   ├── 03_retrieval_workers.md                 ← Graph/Hybrid/Document-block workers, EvidenceBlock
│   ├── 04_evidence_and_claims.md               ← Evidence Requirement Gate, Context Builder, Claim-first Generator
│   ├── 05_verification_and_answer_gate.md      ← Deterministic claim verifier, Answer Gate
│   └── 06_recovery_memory_and_harness.md       ← Critic/Supervisor recovery, user memory, risk management
│
├── 05_config_and_schemas/
│   ├── 01_pipeline_config.md                   ← Full Config and harness extension management items
│   └── 02_data_schemas.md                      ← Core schemas + trace/eval/run/ledger schema
│
└── 06_pipeline_runtime/
    ├── 01_offline_pipeline.md                  ← offline flow, verification, regression gate
    └── 02_online_query_pipeline.md             ← online flow, self-repair, HITL, metrics
```

---

## Quick Reference

| What you want to find | Document |
|-----------------------|----------|
| **Full pipeline** | [00_overview.md](00_overview.md) |
| **Problem definition / inputs / outputs / failure risks** | [00_overview.md § 3](00_overview.md) |
| **Constraint / Context / Verification / Feedback Loop** | [00_overview.md § 6](00_overview.md) |
| **Question types and finance-specific failure taxonomy** | [00_overview.md § 4](00_overview.md), [00_overview.md § 9](00_overview.md) |
| DART/Naver collection approach | [01_data_pipeline/01_ingestion.md](01_data_pipeline/01_ingestion.md) |
| SimHash/Jaccard deduplication | [01_data_pipeline/02_normalization.md](01_data_pipeline/02_normalization.md) |
| NER with four strategies (recall first) | [02_preprocessing/02_ner_extractor.md](02_preprocessing/02_ner_extractor.md) |
| Entity Resolution details | [02_preprocessing/04_entity_resolver.md](02_preprocessing/04_entity_resolver.md) |
| Event type hierarchy | [03_knowledge_graph/01_ontology.md](03_knowledge_graph/01_ontology.md) |
| Node/edge schema + loading rules | [03_knowledge_graph/02_graph_schema.md](03_knowledge_graph/02_graph_schema.md) |
| PassageIndex structure | [03_knowledge_graph/03_graph_loader.md](03_knowledge_graph/03_graph_loader.md) |
| Full agent architecture, execution loop, ledger | [04_agent_system/01_agent_architecture.md](04_agent_system/01_agent_architecture.md) |
| QuerySpec generation prompt and Retrieval Policy | [04_agent_system/02_query_understanding_and_routing.md](04_agent_system/02_query_understanding_and_routing.md) |
| Graph/Hybrid/Document-block retrieval, EvidenceBlock structure | [04_agent_system/03_retrieval_workers.md](04_agent_system/03_retrieval_workers.md) |
| Evidence Requirement Gate, claim-first generation | [04_agent_system/04_evidence_and_claims.md](04_agent_system/04_evidence_and_claims.md) |
| Deterministic numeric/temporal/attribution verification, Answer Gate | [04_agent_system/05_verification_and_answer_gate.md](04_agent_system/05_verification_and_answer_gate.md) |
| Critic/Supervisor recovery, user memory, risk management | [04_agent_system/06_recovery_memory_and_harness.md](04_agent_system/06_recovery_memory_and_harness.md) |
| KG-miss handling, self-repair, real-time supplemental collection | [06_pipeline_runtime/02_online_query_pipeline.md](06_pipeline_runtime/02_online_query_pipeline.md) |
| Offline verification points and regression gate | [06_pipeline_runtime/01_offline_pipeline.md](06_pipeline_runtime/01_offline_pipeline.md) |
| Configuration and version management from a CI/CD gate perspective | [05_config_and_schemas/01_pipeline_config.md](05_config_and_schemas/01_pipeline_config.md) |
| trace / eval / run / ledger metadata schema | [05_config_and_schemas/02_data_schemas.md](05_config_and_schemas/02_data_schemas.md) |
