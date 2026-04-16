# 02. Entity Candidate Extraction (NER Extractor)

## 1. Purpose

Extract **mention spans** from each sentence in `PreprocessedDocument` as broadly as possible so they can serve as candidates for KG loading.

This stage follows a **recall-first** strategy. Incorrect mentions can be filtered later during type classification and Entity Resolution, so the goal here is to gather as many candidates as possible without missing relevant ones.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `PreprocessedDocument` list | Documents with sentence splitting completed |
| `ReferenceDataManager` | Dictionaries for listed companies, industries, institutions, regions, and commodities |
| `NERConfig` | Entity length thresholds and pattern definitions |

### Output

`Dict[canonical_doc_id, List[MentionSpan]]`

`MentionSpan` structure:

| Field | Type | Description |
|------|------|-------------|
| `mention_id` | str | UUID, prefix `men_` |
| `mention_text` | str | Extracted text |
| `sentence_id` | str | Source sentence ID |
| `char_start` | int | Start offset within the sentence |
| `char_end` | int | End offset within the sentence |
| `mention_source` | str | Extraction method identifier |
| `ner_confidence` | float | Extraction confidence, 0.0 to 1.0 |

---

## 3. Processing Logic

Apply four strategies in sequence and remove duplicate spans by offset.

### Strategy 1: Reference Dictionary Matching

Load the following five dictionaries from `ReferenceDataManager`.

| Dictionary | Source |
|------------|--------|
| Listed company names and aliases | Full DART listed company universe |
| Industry names | External industry taxonomy |
| Institution names | Institution reference data |
| Region names | Region and country reference data |
| Commodity names | Commodity reference data |

**Longest-string-first matching**: Sort dictionary entries by descending string length. For example, `Hyundai Motor Group` is matched before `Hyundai Motor`, preventing short aliases from matching redundantly inside longer names.

```python
self._all_dict_entries.sort(key=lambda item: len(item[0]), reverse=True)
```

`mention_source = "dictionary_match"`, `ner_confidence = 0.85`

### Strategy 2: Structured Value Rule Parser

Use regex rules to extract amounts, dates, and percentages.

**Amount patterns:**

```python
r"(\d[\d,]*\.?\d*)\s*(원|억원|만원|조원|천원|달러|USD|EUR|JPY|CNY)"
r"(약\s*)?\d[\d,]*\.?\d*\s*(억|조|만)\s*원"
```

**Date patterns:**

```python
r"\d{4}[년./-]\s*\d{1,2}[월./-]\s*\d{1,2}[일]?"
r"\d{4}[년.]\s*\d{1,2}[월.]"
r"(?:올해|내년|작년|금년)\s*\d{1,2}[월]"
```

**Percentage pattern:**

```python
r"(\d+\.?\d*)\s*%"
```

`mention_source = "rule_parser"`, `ner_confidence = 0.90`

### Strategy 3: Event Trigger Lexicon

Define trigger expressions for 14 event types in advance. When one of those expressions appears in a sentence, it is extracted as a mention.

| Event type | Major triggers |
|------------|----------------|
| `ContractEvent` | contract, order win, supply contract, signing, agreement, MOU, partnership, joint venture |
| `EarningsEvent` | earnings, revenue, operating profit, net income, loss, return to profit, sales, export |
| `CorporateAction` | launch, announcement, investment, capacity expansion, mass production, EV, autonomous driving |
| `DividendEvent` | dividend, cash dividend, interim dividend, year-end dividend |
| `BuybackEvent` | treasury stock, treasury share acquisition, cancellation |
| `M&AEvent` | acquisition, merger, equity acquisition, acquired company, control |
| `RatingChange` | rating, credit rating, upgrade, downgrade, rating revision |
| `PolicyAnnouncement` | policy, bill, regulation, implementation, subsidy, tax system, promotion |
| `RegulationEvent` | sanction, penalty surcharge, administrative action, corrective order, recall order |
| `SupplyDisruption` | supply disruption, production suspension, plant shutdown, recall, parts shortage |
| `MacroRelease` | interest rate, base rate, exchange rate, GDP, CPI, tariff |
| `LawsuitEvent` | lawsuit, damages, legal dispute, judgment, patent lawsuit |
| `GuidanceChange` | guidance, outlook, target, downward revision, upward revision |
| `ManagementChange` | CEO, executive, appointment, resignation, reorganization |
| `LaborEvent` | strike, union, labor-management, collective bargaining, wage negotiation |

`mention_source = "trigger_lexicon"`, `ner_confidence = 0.70`

### Strategy 4: Counterparty Placeholder Pattern

Extract placeholder candidates such as `Company A`, `Group B`, `partner firm`, and `customer`, where the real company name is not explicitly stated.

`mention_source = "placeholder_pattern"`, `ner_confidence = 0.50`

---

## 4. Dependencies and Connected Modules

### Upstream

- `doc_preprocessor.py` → `PreprocessedDocument`, including `sentences`
- `reference/company_data.py` → five domain dictionaries

### Downstream

- `entity_type_classifier.py` → confirms types using `MentionSpan` plus local context
- `event_extractor.py` → uses trigger-lexicon-based mentions as event triggers

### External Dependencies

- `NERConfig` (`config/settings.py`): `min_entity_length=2`, `max_entity_length=30`, confidence thresholds
- Python `re`: compiled structured-value patterns

---

## 5. Position in the Data Flow

```text
[Document Preprocessor]
        │  PreprocessedDocument (sentences)
        ▼
[NER Extractor]   ← This document
        │  Dict[doc_id, List[MentionSpan]]
        ▼
[Entity Type Classifier]
```

---

## 6. Implementation Design Standards

### Dictionary Initialization

Executed once in the constructor.

```python
def __init__(self, config: NERConfig, ref_data: ReferenceDataManager):
    # Merge five dictionaries and sort by descending length
    self._all_dict_entries = []
    for name in ref_data.get_all_company_names():
        self._all_dict_entries.append((name, "Company"))
    # ... add Industry, Institution, Region, Commodity
    self._all_dict_entries.sort(key=lambda item: len(item[0]), reverse=True)

    # Precompile structured-value patterns once
    self._money_patterns = [re.compile(p) for p in config.money_patterns]
    self._date_patterns  = [re.compile(p) for p in config.date_patterns]
    self._pct_pattern    = re.compile(r"(\d+\.?\d*)\s*%")
```

### Duplicate Span Removal

If mentions overlap by offset within the same sentence, keep the one with higher confidence.

### Batch Processing

`extract_batch(preprocessed_docs)` → `Dict[canonical_doc_id, List[MentionSpan]]`

---

## 7. Design Rationale

**Why not use an ML-based NER model?**  
The full DART listed-company universe, more than 2,500 names, can be covered completely by a dictionary. ML models are more expensive at inference time and require retraining whenever new domain vocabulary must be added. Dictionary matching is deterministic, fast, and can reflect a newly listed company immediately through dictionary updates alone.

**Why prioritize recall?**  
False positives at this stage can be filtered later with low confidence during type classification and Entity Resolution. False negatives, however, cannot be recovered later. For that reason, the NER confidence threshold, `ner_confidence_threshold=0.5`, is intentionally kept low to collect candidates broadly.
