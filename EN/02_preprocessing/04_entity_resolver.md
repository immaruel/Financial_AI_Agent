# 04. Entity Resolution

## 1. Purpose

Analyze `TypedMention` objects with confirmed types, determine whether different surface forms refer to the same real-world target, and connect them to a single `canonical_entity_id`.

Example: `Hyundai Motor`, `HMC`, and `Hyundai Motor Co., Ltd.` → `entity_hyundai_motor`

If a mention cannot be resolved, generate a placeholder and manage it later in the graph as a `CounterpartyPlaceholder` node. The output of this stage determines the unique identifier for nodes in the KG.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `Dict[doc_id, List[TypedMention]]` | Mentions after type classification |
| `Dict[doc_id, PreprocessedDocument]` | Sentence context |
| `ReferenceDataManager` | Canonical entity dictionaries, IDs plus alias lists |
| `EntityResolutionConfig` | Similarity thresholds |

### Output

`Dict[canonical_doc_id, List[ResolvedMention]]`

`ResolvedMention` structure:

| Field | Type | Description |
|------|------|-------------|
| `mention_id` | str | Inherits the original mention ID |
| `mention_text` | str | Original text |
| `sentence_id` | str | Source sentence ID |
| `entity_type` | str | Confirmed type |
| `canonical_entity_id` | str | Resolved canonical ID |
| `canonical_name` | str | Official name |
| `resolution_method` | str | Resolution method identifier |
| `resolution_confidence` | float | Resolution confidence |
| `resolution_status` | ResolutionStatus | `resolved` / `placeholder` / `unresolved` |

---

## 3. Processing Logic

Apply different resolution strategies by `entity_type`.

### 3.1 Company Resolution

Use the following four-stage order.

```text
Stage 1: Exact Alias Match
  mention_text exists exactly in alias_dict
  → resolution_status = "resolved"
  → resolution_method = "exact_alias"

Stage 2: Fuzzy Match (threshold: 80)
  rapidfuzz.fuzz.partial_ratio(mention_text, alias) >= alias_fuzzy_threshold
  → resolution_status = "resolved"
  → resolution_method = "fuzzy_alias"

Stage 3: Embedding Similarity (best among top-k candidates)
  cosine_similarity(embed(mention_text), embed(candidate)) >= embedding_similarity_threshold (0.80)
  → resolution_status = "resolved"
  → resolution_method = "embedding"

Stage 4: Placeholder Generation
  All stages fail or confidence < placeholder_confidence (0.50)
  → canonical_entity_id = "company_placeholder_{index:06d}"
  → resolution_status = "placeholder"
```

### 3.2 Industry / Institution / Region / Commodity Resolution

Run exact match only. If matching fails, mark the mention as unresolved.

```text
mention_text exists exactly in reference_dict
  → resolution_status = "resolved"

match fails
  → resolution_status = "unresolved"
  → skipped later during graph loading
```

### 3.3 MoneyAmount / Date / Percentage / EventTrigger Resolution

Do not assign separate canonical IDs. These are treated as event attributes, not graph nodes, so they are marked with `resolution_status="resolved"` while leaving `canonical_entity_id=None`.

---

## 4. Dependencies and Connected Modules

### Upstream

- `entity_type_classifier.py` → `TypedMention`
- `reference/company_data.py` → alias dictionaries and `canonical_entity_id` mappings

### Downstream

- `event_extractor.py` → uses `ResolvedMention` for subject and object entity assignment
- `graph_loader.py` → uses `canonical_entity_id` as the graph node key

### External Dependencies

- `rapidfuzz`: alias fuzzy matching
- Embedding model, `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, for embedding similarity
- `EntityResolutionConfig` (`config/settings.py`)

---

## 5. Position in the Data Flow

```text
[Entity Type Classifier]
        │  Dict[doc_id, List[TypedMention]]
        ▼
[Entity Resolver]   ← This document
        │  Dict[doc_id, List[ResolvedMention]]
        ├──→ [Event Extractor]   (determines subject/object entities)
        └──→ [Graph Loader]      (uses canonical_entity_id when creating nodes)
```

---

## 6. Implementation Design Standards

### Placeholder Management

Generate internal IDs in the form `company_placeholder_{index:06d}`. Placeholders are loaded into the KG as a dedicated node type, `CounterpartyPlaceholder`, and can later be updated into real Company nodes if more evidence arrives.

### Resolution Statistics Logging

```python
resolved_count = sum(
    1 for rlist in resolved_by_doc.values()
    for r in rlist if r.resolution_status.value == "resolved"
)
logger.info(f"Entity Resolution → {resolved_count} resolved")
```

If the `resolved` ratio is low during pipeline execution, dictionary quality or NER accuracy should be suspected first.

### Batch Processing Method

```python
resolve_batch(
    typed_by_doc: Dict[str, List[TypedMention]],
    doc_map: Dict[str, PreprocessedDocument]
) -> Dict[str, List[ResolvedMention]]
```

---

## 7. Design Rationale

**Why use the four-stage strategy only for Company?**  
Company names have the widest variation in surface form, including abbreviations, English names, and former names. Industry and region names, by contrast, usually follow standardized taxonomies, so exact match is sufficient. Adding embeddings only for company resolution is a response to this wider variation.

**Why generate placeholders instead of deleting unresolved mentions?**  
Even if the exact counterparty is unknown, a fact such as "signed a contract with an unidentified customer" still carries useful signal. Preserving it as a placeholder allows later replacement with the real entity if more evidence accumulates, and also makes it possible to analyze patterns of unidentified related firms in the graph.
