# 01. Pipeline Configuration

## 1. Purpose

Manage all tunable parameters for the full pipeline centrally in `config/settings.py`. Each processing stage references only its corresponding Config instance, and parameter changes are made in that single file.

From a harness engineering perspective, configuration is not just a collection of thresholds. It is also the control point for:

- which rules are currently active
- which experiment version was evaluated
- which gates must pass before deployment
- which context bundles the agent references while running

In other words, this document summarizes both the **current Config structure in code** and the **operational settings that should be versioned alongside future harness extensions**.

---

## 2. Current Configuration Class Structure

One `PipelineConfig` includes the following 13 sub-configs.

```python
@dataclass
class PipelineConfig:
    collection:            CollectionConfig
    normalization:         NormalizationConfig
    preprocessing:         PreprocessingConfig
    ner:                   NERConfig
    entity_typing:         EntityTypingConfig
    entity_resolution:     EntityResolutionConfig
    event_extraction:      EventExtractionConfig
    event_canonicalization: EventCanonicalizationConfig
    neo4j:                 Neo4jConfig
    llm:                   LLMConfig
    embedding:             EmbeddingConfig
    ray:                   RayConfig
    agent:                 AgentConfig
```

This structure reflects the **actual parameter groups used by the codebase**.

---

## 3. Major Parameters by Stage

### `CollectionConfig`, Document Collection

| Parameter | Default | Role |
|-----------|---------|------|
| `filing_poll_interval_sec` | 300 | filing check interval |
| `news_poll_interval_sec` | 600 | news check interval |
| `filing_lookback_days` | 3 | filing lookback window |
| `news_lookback_hours` | 24 | news lookback window |
| `dart_api_key` | hardcoded | DART API credential |
| `news_api_key` / `news_api_secret` | hardcoded | Naver API credential |
| `news_search_keywords` | 10 companies | search keywords for news collection |
| `news_display_count` | 100 | maximum collected per keyword |
| `max_concurrent_requests` | 10 | request concurrency |

> **Security note**: API keys exist directly in code. In production, they should be moved to environment variables, a secret manager, or CI-injected secrets.

### `NormalizationConfig`, Normalization

| Parameter | Default | Role |
|-----------|---------|------|
| `simhash_distance_threshold` | 5 | Hamming-distance threshold for near duplicates |
| `near_duplicate_jaccard_threshold` | 0.80 | Jaccard threshold for confirming near duplicates |

### `PreprocessingConfig`, Preprocessing

| Parameter | Default | Role |
|-----------|---------|------|
| `min_sentence_length` | 5 | minimum sentence length |
| `max_sentence_length` | 500 | maximum sentence length |
| `filing_subtypes` | rule dict | filing subtype classification |
| `news_subtypes` | rule dict | news subtype classification |

### `NERConfig`, Entity Extraction

| Parameter | Default | Role |
|-----------|---------|------|
| `min_entity_length` | 2 | minimum entity character count |
| `max_entity_length` | 30 | maximum entity character count |
| `ner_confidence_threshold` | 0.5 | low threshold for recall-first extraction |
| `trigger_lexicon` | dictionaries for 14 types | event trigger expressions |

### `EntityTypingConfig`, Type Classification

| Parameter | Default | Role |
|-----------|---------|------|
| `exact_match_confidence` | 0.80 | confidence for exact dictionary match |
| `fuzzy_match_threshold` | 80 | `rapidfuzz` score threshold |
| `llm_fallback_threshold` | 0.60 | branch point for LLM fallback |

### `EntityResolutionConfig`, Entity Resolution

| Parameter | Default | Role |
|-----------|---------|------|
| `embedding_similarity_threshold` | 0.80 | embedding similarity threshold |
| `alias_fuzzy_threshold` | 80 | alias fuzzy-match threshold |
| `placeholder_confidence` | 0.50 | branch point for placeholder generation |

### `EventExtractionConfig`, Event Extraction

| Parameter | Default | Role |
|-----------|---------|------|
| `event_confidence_threshold` | 0.50 | minimum confidence for event candidate creation |
| `fact_keywords` | keyword list | keywords for confirmed-fact judgment |
| `interpretation_keywords` | keyword list | keywords for interpretation or prediction judgment |

### `EventCanonicalizationConfig`, Event Canonicalization

| Parameter | Default | Role |
|-----------|---------|------|
| `same_event_threshold` | 0.85 | threshold for definite merge |
| `maybe_same_threshold` | 0.65 | threshold for low-confidence merge |
| `time_window_days` | 7 | blocking time window |
| `field_weights` | six fields | weights for similarity calculation |

### `Neo4jConfig`, Graph Loading

| Parameter | Default | Role |
|-----------|---------|------|
| `uri` | `bolt://localhost:7687` | Neo4j connection URI |
| `precedes_max_lag_days` | 30 | time window for creating `PRECEDES` edges |
| `batch_size` | 500 | batch load size |

### `LLMConfig`, LLM

| Parameter | Default | Role |
|-----------|---------|------|
| `model_name` | `Qwen/Qwen2.5-3B-Instruct` | model used |
| `device` | `cuda` | GPU device |
| `torch_dtype` | `float16` | FP16 optimized for T4 GPU |
| `max_new_tokens` | 1024 | maximum generation tokens |
| `load_in_4bit` | False | 4-bit quantization option |

### `AgentConfig`, Agent Layer

| Parameter | Default | Role |
|-----------|---------|------|
| `max_hops` | 2 | default retrieval hop depth |
| `max_subgraph_nodes` | 50 | maximum subgraph node count |
| `min_edge_confidence` | 0.60 | minimum edge confidence for traversal |
| `temporal_window_days` | 90 | default temporal window |
| `prohibited_phrases` | 7 entries | forbidden phrases for Risk Controller |

---

## 4. Harness Engineering Extension Management Items

The current `PipelineConfig` manages execution parameters. Once harness engineering is applied, it is better to manage an additional set of **operational-level configuration bundles** alongside it.

### 4.1 Constraint Layer Configuration

Recommended items:

| Item | Description |
|------|-------------|
| tool boundary policy | which component may call which tools or APIs |
| dependency rule | prevents planner from bypassing retrieval |
| safety rule | blocks investment advice, overconfidence, and unsupported causal certainty |
| retry budget | maximum retry count for self-repair |

Suggested file or storage examples:

- `constraint_policy.yaml`
- CI environment variables or release profile

### 4.2 Context Layer Configuration

Recommended items:

| Item | Description |
|------|-------------|
| ontology version | version of event types, entity types, and edge constraints |
| schema version | version of trace / eval / answer schema |
| prompt bundle version | version of planner / composer / checker prompts |
| eval slice version | version of query-slice definitions |
| failure taxonomy version | version of error category definitions |

Because these assets are executable context the agent must always consult, they should be managed as structured files rather than being left as prose only.

### 4.3 Verification Layer Configuration

Recommended items:

| Item | Description |
|------|-------------|
| evidence sufficiency threshold | minimum number of supporting items per core claim |
| temporal consistency threshold | allowed range for temporal inconsistency |
| unsupported claim fail condition | tolerance limit for unsupported claims |
| advice risk threshold | threshold for blocking risky wording |
| regression gate profile | defines which metric drops count as hard failure |

### 4.4 Feedback Loop Layer Configuration

Recommended items:

| Item | Description |
|------|-------------|
| drift alert threshold | threshold for alias or event-expression drift |
| cleanup TTL | retention period for traces and experiment artifacts |
| rollback rule | defines which version to roll back to after regression |
| review escalation rule | trigger conditions for human-in-the-loop |

---

## 5. Configuration Management from a CI/CD Gate Perspective

In harness engineering, a configuration change is itself an experiment unit. Because of that, the following metadata should be recorded together with each run.

| Metadata | Description |
|----------|-------------|
| `run_id` | evaluation or experiment run identifier |
| `dataset_version` | version of the evaluation set used |
| `prompt_bundle_version` | prompt bundle version |
| `retriever_version` | retrieval-policy version |
| `extractor_version` | extraction-policy version |
| `config_snapshot` | snapshot of thresholds and settings actually used |
| `aggregate_metrics` | top-level metric summary |
| `slice_metrics` | performance by query slice |

Example gate policy:

- hard gate:
  - ontology violation occurs
  - safety or compliance failure
  - schema validation failure
- soft gate:
  - grounded-answer score drops
  - temporal consistency drops
  - latency or cost spikes

---

## 6. Design Rationale

**Why use dataclass-based config?**  
Unlike Pydantic, it adds no runtime validation overhead and supports safe mutable defaults through `field(default_factory=...)`. Configuration is loaded once during pipeline initialization, so static clarity matters more than runtime validation here.

**Why keep all Config objects in one file?**  
If stage-level configs are split across many files, related parameters become scattered and tuning requires opening multiple files. Keeping everything in `settings.py` makes it easy to see which parameter belongs to which stage and how stage-level dependencies connect.

**Why document harness configuration separately?**  
If only execution parameters are versioned, the code change history may show what changed but not why operational rules or evaluation criteria changed. A financial AI agent must manage safety, freshness, and groundedness together, so execution settings and operational settings should be versioned side by side.
