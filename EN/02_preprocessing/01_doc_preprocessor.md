# 01. Document Preprocessor

## 1. Purpose

Convert `CanonicalDocument` into a common format that supports downstream NLP processing. Concretely, this stage splits the body into sentences, classifies document subtype, and produces `PreprocessedDocument`.

This is the entry point to STEP 2, document preprocessing. All later preprocessing modules, including NER and event extraction, consume this output.

---

## 2. Inputs / Outputs

### Input

List of `CanonicalDocument` objects, output from `document_fingerprint.py`, limited to documents with `doc_status="active"`

### Output

`PreprocessedDocument` (`utils/schemas.py`)

| Field | Type | Description |
|------|------|-------------|
| `canonical_doc_id` | str | Original document ID, same as in `CanonicalDocument` |
| `source_type` | SourceType | `filing` / `news` |
| `title_text` | str | Cleaned title |
| `sentences` | List[Sentence] | Split sentence list |
| `doc_subtype` | str | Document subtype, for example `earnings` or `company_event` |
| `doc_parse_meta` | Dict | Parsing metadata |
| `published_at` | datetime | Publication time |

`Sentence` structure:

| Field | Type | Description |
|------|------|-------------|
| `sentence_id` | str | `{canonical_doc_id}_s{index}` |
| `text` | str | Original sentence text |
| `char_start` | int | Start offset in the source document |
| `char_end` | int | End offset in the source document |

---

## 3. Processing Logic

### 3.1 Sentence Splitting

The splitting strategy differs by `source_type`.

**News sentence splitting:**

Use Korean sentence-ending rules. Sentences are split using patterns such as `.`, `다.`, `함.`, `됨.`, and `임.`.

**Filing sentence splitting:**

Filings recognize itemized structures such as numbered lists and `field: value` patterns, and segment around those structure units. Narrative sentences and structured items are handled differently.

**Sentence length filter:**

```python
min_sentence_length = 5    # remove sentences shorter than 5 characters
max_sentence_length = 500  # split sentences longer than 500 characters
```

### 3.2 Document Subtype Classification

Classify the detailed document type based on keywords in `normalized_text` and `title`. The first matched subtype in the matching order is selected.

**Filing subtypes:**

| Subtype | Keywords |
|---------|----------|
| `earnings` | operating profit, revenue, net income, earnings, quarterly report |
| `contract` | supply contract, order win, delivery, contract signing |
| `dividend` | dividend, cash dividend, dividend per share |
| `buyback` | treasury stock, treasury shares, acquisition |
| `mna` | acquisition, merger, equity acquisition, management control |
| `capital` | rights offering, bonus issue, convertible bond, new shares |
| `regulation` | administrative action, penalty surcharge, corrective order, sanction |

**News subtypes:**

| Subtype | Keywords |
|---------|----------|
| `company_event` | contract, order, earnings, filing, announcement |
| `industry_trend` | industry, market, trend, outlook, growth |
| `policy` | policy, regulation, bill, government, system |
| `macro` | interest rate, exchange rate, inflation, GDP, employment |

`doc_subtype` is later used by event extraction to choose trigger lexicons and adjust confidence.

---

## 4. Dependencies and Connected Modules

### Upstream

- `document_fingerprint.py` → list of `CanonicalDocument`

### Downstream

- `ner_extractor.py` → consumes `sentences` from `PreprocessedDocument`
- `event_extractor.py` → refers to `doc_subtype` during event frame generation

### External Dependencies

- Python `re`: sentence splitting patterns
- `PreprocessingConfig` (`config/settings.py`): sentence length thresholds and subtype keyword dictionaries

---

## 5. Position in the Data Flow

```text
[Document Fingerprinting]
        │  CanonicalDocument (doc_status="active")
        ▼
[Document Preprocessor]   ← This document
        │  PreprocessedDocument
        ├──→ [NER Extractor]          (sentences input)
        ├──→ [Event Extractor]        (uses doc_subtype)
        └──→ [Graph Loader]           (used when constructing passages)
```

---

## 6. Implementation Design Standards

### Batch Processing

Use `preprocess_batch(canonical_docs: List[CanonicalDocument])` to process the full document list in one pass. Internally, documents are processed sequentially, but the design allows later migration to Ray Actor-based parallel processing if document volume grows.

### `sentence_id` Rule

```python
sentence_id = f"{canonical_doc_id}_s{index}"
```

This ID is later used as the linkage key in `MentionSpan`, `EvidenceSpan`, and `PassageRecord`.

### Separate Preservation of `title_text`

`title_text` is preserved separately from body sentences. Titles are also processed independently during NER, and filing titles often concentrate event-trigger language, making that separation useful.

---

## 7. Design Rationale

**Why use rules instead of an ML model for sentence splitting?**  
Financial filings and news have predictable domain vocabulary and structure. Rule-based sentence splitting is fast, consistent, and tunable through parameters such as `min_sentence_length` and `max_sentence_length`. Remaining sentence-splitting errors can be absorbed later through NER confidence.

**Why classify document subtype at this stage?**  
During event extraction, trigger lexicon priority and confidence weights must vary by document type. For example, a mention of "revenue" in an `earnings` filing should receive higher confidence than the same mention in a `policy` news article.
