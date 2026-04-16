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

In other words, the documents cover both "what was implemented" and "how it will be operated and validated."

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
├── 04_agent_system/                            ← Agentic GraphRAG
│   ├── 01_agent_architecture.md                ← 7-agent components, execution loop, trace, recovery
│   ├── 02_query_planner.md                     ← Query normalization, intent classification, entity extraction
│   ├── 03_graph_retriever.md                   ← Seed discovery, hop/edge strategy, truncation
│   ├── 04_evidence_retriever.md                ← PassageIndex-based source recovery, conflict detection
│   ├── 05_causal_reasoner.md                   ← Temporal/causal reconstruction, CausalChain
│   └── 06_risk_controller_and_answer_composer.md ← checker/composer/risk control
│
├── 05_config_and_schemas/
│   ├── 01_pipeline_config.md                   ← Current Config + harness extension management items
│   └── 02_data_schemas.md                      ← Core schemas + trace/eval/run schema
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
| Agent execution loop and recovery | [04_agent_system/01_agent_architecture.md](04_agent_system/01_agent_architecture.md) |
| KG miss handling and self-repair | [06_pipeline_runtime/02_online_query_pipeline.md](06_pipeline_runtime/02_online_query_pipeline.md) |
| Offline verification points and regression gate | [06_pipeline_runtime/01_offline_pipeline.md](06_pipeline_runtime/01_offline_pipeline.md) |
| Configuration and version management from a CI/CD gate perspective | [05_config_and_schemas/01_pipeline_config.md](05_config_and_schemas/01_pipeline_config.md) |
| trace / eval / run metadata schema | [05_config_and_schemas/02_data_schemas.md](05_config_and_schemas/02_data_schemas.md) |
