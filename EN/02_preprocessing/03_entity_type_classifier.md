# 03. Entity Type Classification

## 1. Purpose

Assign a financial KG entity type to each `MentionSpan` extracted in the NER stage. The confirmed type becomes the branching key that determines which dictionary and algorithm the later Entity Resolution stage should use.

**Current implementation priority**: Reference Exact Match → Fuzzy Match → Context Rule

LLM fallback remains a valid extension option in the design, but the default implementation path focuses on rule-based and reference-based classification.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `Dict[doc_id, List[MentionSpan]]` | NER extraction result |
| `Dict[doc_id, PreprocessedDocument]` | Used to reference sentence context |
| `ReferenceDataManager` | Dictionaries for listed companies, industries, and institutions |
| `EntityTypingConfig` | Confidence thresholds and allowed type list |

### Output

`Dict[canonical_doc_id, List[TypedMention]]`

`TypedMention` structure:

| Field | Type | Description |
|------|------|-------------|
| `mention_id` | str | Inherits the source `MentionSpan` ID |
| `mention_text` | str | Original text |
| `sentence_id` | str | Source sentence ID |
| `entity_type` | str | Confirmed entity type |
| `type_confidence` | float | Confidence for the type assignment |
| `type_method` | str | Identifier for the typing method |

---

## 3. Processing Logic

### Allowed Entity Type List

```python
allowed_entity_types = [
    "Company", "Industry", "Institution", "Region", "Country",
    "Commodity", "Currency", "Index", "Policy", "Person",
    "MoneyAmount", "Percentage", "Date", "Quantity",
    "EventTrigger", "CounterpartyPlaceholder",
]
```

### 3.1 Reference Exact Match

Look up `mention_text` exactly in each dictionary provided by `ReferenceDataManager`.

```text
mention_text in company_names      → entity_type="Company", confidence=0.80
mention_text in industry_names     → entity_type="Industry", confidence=0.80
mention_text in institution_names  → entity_type="Institution", confidence=0.80
...
```

`type_method = "reference_exact_match"`

### 3.2 Fuzzy Match

If exact match fails, attempt fuzzy matching with `rapidfuzz`.

```python
score = fuzz.ratio(mention_text, candidate_name)
if score >= fuzzy_match_threshold:  # default: 80
    entity_type = candidate_type
    confidence = fuzzy_match_confidence  # default: 0.80
```

`type_method = "fuzzy_match"`

### 3.3 Context Rule

If `mention_source` is `rule_parser`, assign the type without requiring sentence context.

```text
mention_source == "rule_parser" + amount pattern      → "MoneyAmount"
mention_source == "rule_parser" + date pattern        → "Date"
mention_source == "rule_parser" + percentage pattern  → "Percentage"
mention_source == "trigger_lexicon"                   → "EventTrigger"
mention_source == "placeholder_pattern"               → "CounterpartyPlaceholder"
```

`type_method = "context_rule"`, `confidence = 0.80`

### 3.4 LLM Fallback, Harness Extension Design

From a future harness engineering perspective, the following optional LLM fallback can be added to reduce low-confidence mentions.

```text
Input: mention_text + surrounding sentence context + allowed type list
Output: {"entity_type": "...", "confidence": 0.xx}
```

Example conditions for use:

- The type cannot be confirmed by rules or reference data
- The company alias is highly ambiguous
- The evaluation harness identifies this classification slice as a bottleneck

Even when LLM fallback is introduced, it must still be paired with JSON-structured output, allowed-type validation, and a confidence gate.

---

## 4. Dependencies and Connected Modules

### Upstream

- `ner_extractor.py` → list of `MentionSpan`
- `doc_preprocessor.py` → `PreprocessedDocument`, used for context
- `reference/company_data.py` → dictionaries

### Downstream

- `entity_resolver.py` → resolves `TypedMention` into canonical entities

### External Dependencies

- `rapidfuzz`: fuzzy matching through `fuzz.ratio`
- `QwenLLMClient` (`utils/llm_client.py`): available for future low-confidence fallback extensions
- `EntityTypingConfig` (`config/settings.py`)

---

## 5. Position in the Data Flow

```text
[NER Extractor]
        │  Dict[doc_id, List[MentionSpan]]
        ▼
[Entity Type Classifier]   ← This document
        │  Dict[doc_id, List[TypedMention]]
        ▼
[Entity Resolver]
```

---

## 6. Implementation Design Standards

### Confidence-Based Branching Flow

```python
# 1. Exact Match
for candidate_name, candidate_type in reference_dict.items():
    if mention_text == candidate_name:
        return TypedMention(entity_type=candidate_type,
                            type_confidence=0.80,
                            type_method="reference_exact_match")

# 2. Fuzzy Match
best_score, best_type = fuzzy_search(mention_text, reference_dict)
if best_score >= config.fuzzy_match_threshold:
    return TypedMention(entity_type=best_type,
                        type_confidence=config.fuzzy_match_confidence,
                        type_method="fuzzy_match")

# 3. Context Rule
if mention.mention_source in ("rule_parser", "trigger_lexicon", "placeholder_pattern"):
    return TypedMention(...)

# 4. LLM Fallback (optional extension)
if current_confidence < config.llm_fallback_threshold:
    result = llm_client.classify_entity_type(mention_text, context)
    return TypedMention(type_method="llm_fallback", ...)
```

### Handling Results Outside the Allowed Type List

If LLM fallback is introduced and returns a type outside `allowed_entity_types`, that mention is treated as untyped. Entity Resolution can then either skip it conservatively or send it to human review.

---

## 7. Design Rationale

**Why keep the LLM only as a fallback option?**  
LLM calls impose significant inference latency and GPU memory cost. Most filing and news mentions can be typed through exact dictionary match or context rules. Operationally, it is better to keep the default path rule-based and reference-based, and add fallback only where a real bottleneck has been observed.

**Why set the confidence threshold to 0.60?**  
If the threshold is too high, LLM usage grows excessively. If it is too low, misclassified mentions propagate into Entity Resolution. A threshold of 0.60 empirically captures the zone where rules provide partial support but confidence is still not sufficient.
