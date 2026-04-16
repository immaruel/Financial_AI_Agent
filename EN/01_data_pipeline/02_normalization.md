# 02. Document Normalization and Fingerprinting

## 1. Purpose

Process collected `RawDocument` objects in two stages to produce the `CanonicalDocument` used by the downstream preprocessing pipeline.

- **Raw Document Normalization**: Convert source-specific response formats into a shared internal schema and clean the text
- **Document Fingerprinting**: Determine duplication, versioning, and correction status for normalized documents, then finalize the representative `CanonicalDocument`

Together, these two stages form the **first deduplication layer** of the system, which later works alongside Event Canonicalization, the third deduplication layer.

---

## 2. Inputs / Outputs

### Input

List of `RawDocument` objects, output from `source_connector.py`

### Output

`CanonicalDocument` (`utils/schemas.py`)

| Field | Type | Description |
|------|------|-------------|
| `canonical_doc_id` | str | Internal UUID, prefix `canon_` |
| `source_type` | SourceType | `filing` / `news` |
| `trust_tier` | int | Source reliability tier, 1 through 5 |
| `title` | str | Cleaned title |
| `normalized_text` | str | Cleaned body text |
| `published_at` | datetime | Publication time |
| `updated_at` | datetime | Modification time |
| `source_url` | str | Source URL |
| `external_doc_id` | str | Source-specific ID |
| `doc_status` | DocStatus | `active` / `superseded` / `duplicate` |
| `parent_doc_id` | str | Original document ID for correction cases |
| `dedup_group_id` | str | Deduplication group identifier |
| `document_class` | str | Document class, subtype |
| `rcept_no` | str | Filing receipt number, filing only |

---

## 3. Processing Logic

### 3.1 Raw Document Normalization (`raw_normalizer.py`)

Normalization branches by `source_type`.

**Common processing:**

1. Remove HTML tags
2. Apply Unicode normalization, NFC
3. Clean repeated whitespace and line breaks
4. Finalize `crawled_at` and `first_seen_at`

**News-specific processing:**

Remove boilerplate through sequential regex patterns.

```python
news_boilerplate_patterns = [
    r"©.*?(?:무단|재배포)",           # copyright notice
    r"기자\s*[가-힣]{2,4}\s*[a-zA-Z0-9_.+-]+@",  # reporter email
    r"\[.*?뉴스.*?\]",               # media tag
    r"▶.*?(?:관련기사|더보기)",       # related article link
]
```

**Filing-specific processing:**

- Preserve `parent_rcept_no` in metadata when `is_correction=True`
- Convert XML-style itemized content into key-value text format

### 3.2 Document Fingerprinting (`document_fingerprint.py`)

Deduplication strategy differs by `source_type`.

**Filing deduplication:**

```text
Same rcept_no → exact_duplicate → doc_status = "duplicate"
Correction filing (is_correction=True) → doc_status = "active"
                                       + link parent_doc_id
                                       + set original doc_status = "superseded"
```

For filings, `rcept_no` is the core key. A repeated receipt number is treated as a duplicate, while a correction filing receives a new `canonical_doc_id` and a parent relationship to the original.

**News deduplication, two-stage strategy:**

```text
Stage 1: exact hash match
   Same SHA-256(normalize(title + body)) → exact_duplicate

Stage 2: SimHash near-duplicate detection
   SimHash Hamming distance ≤ simhash_distance_threshold (default: 5)
   → near_duplicate candidate

Stage 3: Jaccard similarity check
   Jaccard(token_set_A, token_set_B) ≥ 0.80
   → confirm near_duplicate → select one representative document,
      mark the rest as doc_status = "duplicate"
```

**Representative document selection within a near-duplicate group:**

1. Prefer lower `trust_tier`, meaning higher reliability, for example filing over news
2. Within the same tier, choose the earliest `published_at`

---

## 4. Dependencies and Connected Modules

### Upstream

- `source_connector.py` → provides a list of `RawDocument`

### Downstream

- `doc_preprocessor.py` → performs sentence splitting on `CanonicalDocument`
- `step1_checkpoint.py` → saves outputs as a JSON checkpoint

### External Dependencies

- `xxhash64`: fast exact hash, configured by `exact_hash_algorithm`
- SimHash implementation: near-duplicate detection
- Python `re`: boilerplate removal patterns

---

## 5. Position in the Data Flow

```text
[Source Connector]
        │  RawDocument
        ▼
[Raw Document Normalization]   ← This document (normalization)
        │  cleaned RawDocument
        ▼
[Document Fingerprinting]      ← This document (deduplication)
        │  CanonicalDocument
        ▼
[STEP 1 Checkpoint]            ← saves step1_checkpoint.json
        │
        ▼
[Document Preprocessor]        → enters STEP 2
```

---

## 6. Implementation Design Standards

### STEP 1 Checkpoint

`step1_checkpoint.py` serializes and saves the `CanonicalDocument` list to JSON after STEP 1 completes. STEP 2 through STEP 4 can load this checkpoint and start without rerunning collection.

```python
# Save
save_step1(active_docs, DEFAULT_STEP1_PATH)

# Load
active_docs = load_step1(DEFAULT_STEP1_PATH)
```

### `doc_status` State Transitions

```text
RawDocument collected
      │
      ├─ new document → CanonicalDocument(doc_status="active")
      │
      ├─ exact duplicate → doc_status="duplicate"
      │
      ├─ correction filing → new doc: doc_status="active"
      │                     original doc: doc_status="superseded"
      │
      └─ near-duplicate → representative: doc_status="active"
                           others: doc_status="duplicate"
```

The downstream pipeline processes only documents where `doc_status == "active"`.

```python
active_docs = [d for d in canonical_docs if d.doc_status.value == "active"]
```

### Preserve Multiple Time Fields

Because filings and news have different notions of time, all five time fields from the collection stage are preserved in `CanonicalDocument`. Agent-side time filtering through `time_constraints` mainly uses `published_at`, but prioritizes `effective_at` for filings.

---

## 7. Design Rationale

**Why separate deduplication strategies for filings and news?**  
Filings have a clear external identifier, `rcept_no`, so hash-based duplication checks are unnecessary. News, however, is often revised and republished by many outlets, so a SimHash plus Jaccard combination is needed. Mixing these strategies would create a risk of misclassifying filing correction history as simple duplication.

**Why separate near-duplicate handling from event-level duplication?**  
As documented in comments inside `document_fingerprint.py`, different articles from different outlets covering the same event can still be valuable as separate pieces of evidence. Document-level near-duplicate removal and event-level duplicate merging in Event Canonicalization serve different goals, so they are kept as separate stages.
