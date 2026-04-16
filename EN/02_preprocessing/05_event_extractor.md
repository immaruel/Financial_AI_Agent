# 05. Event Extraction

## 1. Purpose

Combine sentences from `PreprocessedDocument` with `ResolvedMention` objects to build an **Event Frame**. This stage transforms document-centered information into event-centered structure and outputs `EventCandidate`, the core unit used by financial KG queries.

Why event extraction is fundamentally needed: most user questions ask about "events," not merely "companies," and Event Canonicalization cannot merge duplicate documents about the same real-world event until an event frame exists first.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `PreprocessedDocument` | Sentence list, `doc_subtype`, metadata |
| `List[ResolvedMention]` | Resolved entities for the document |
| `EventExtractionConfig` | Event confidence threshold and factuality keywords |
| `NERConfig` | Trigger lexicon, event-type trigger dictionary |

### Output

`List[EventCandidate]`

`EventCandidate` structure:

| Field | Type | Description |
|------|------|-------------|
| `event_candidate_id` | str | UUID, prefix `evt_cand_` |
| `canonical_doc_id` | str | Source document ID |
| `source_type` | SourceType | Document type |
| `event_type` | str | Event type, one of the 14 types |
| `event_subtype` | str | Event subtype |
| `subject_entity_id` | str | Canonical ID of the subject entity |
| `object_entity_id` | str | Canonical ID of the target entity, optional |
| `trigger_text` | str | Expression that triggered the event |
| `amount` | MoneyAmount | Monetary information, if present |
| `event_time` | datetime | Event occurrence time |
| `certainty` | Certainty | `disclosed` / `reported` / `estimated` / `speculated` |
| `factuality` | Factuality | `fact` / `interpretation` / `rumor` / `unknown` |
| `polarity` | Polarity | `positive` / `negative` / `neutral` / `mixed` |
| `evidence` | List[EvidenceSpan] | Supporting sentence list |
| `confidence` | float | Event extraction confidence |
| `slots` | Dict | Additional attribute slots |

---

## 3. Processing Logic

### 3.1 Trigger Detection

Search for mentions of type `EventTrigger` in each sentence, which are extracted during the NER stage through `trigger_lexicon`. Event frame generation begins only from sentences where a trigger exists.

### 3.2 Subject / Object Assignment

```text
Based on trigger position:
  - The Company mention closest to the trigger → subject_entity_id
  - The second Company mention or a Placeholder → object_entity_id
```

If the document type is `filing`, the filing entity identified by `corp_code` is assigned to the subject with priority.

### 3.3 Slot Filling

Fill required slots for each event type from mentions in the same sentence or adjacent sentences.

| Slot | Source mention type |
|------|---------------------|
| `amount` | MoneyAmount |
| `event_time` | Date |
| `percentage` | Percentage |

### 3.4 Factuality Judgment

Determine factuality based on keywords in the sentence.

**Fact keywords** for confirmed facts:  
`disclosed`, `filed`, `announced`, `reported`, `confirmed`, `signed`, `completed`, `decided`

**Interpretation keywords** for analysis or prediction:  
`is expected`, `appears to`, `is forecast`, `is observed`, `possibility`, `concern`, `expectation`, `analyzed`, `evaluated`

```text
contains fact_keywords           → factuality = "fact",           certainty = "disclosed"
contains interpretation_keywords → factuality = "interpretation", certainty = "estimated"
default                          → factuality = "unknown",        certainty = "reported"
```

### 3.5 Event Type Hierarchy

For the complete hierarchy of the 14 leaf event types, see [03_knowledge_graph/01_ontology.md §3.2](../03_knowledge_graph/01_ontology.md).

`event_type` stores the leaf type, such as `ContractEvent`, while `event_subtype` stores the higher-level category, such as `CorporateAction`. The trigger-to-leaf mapping is defined in `NERConfig.trigger_lexicon`.

### 3.6 `EvidenceSpan` Generation

Preserve the sentence from which the event was extracted as `EvidenceSpan`.

```python
EvidenceSpan(
    canonical_doc_id=doc.canonical_doc_id,
    sentence_id=sentence.sentence_id,
    text=sentence.text,
    char_start=sentence.char_start,
    char_end=sentence.char_end,
)
```

This `EvidenceSpan` is later indexed into `PassageIndex` and used by the agent's Evidence Retriever to recover the original text.

---

## 4. Dependencies and Connected Modules

### Upstream

- `doc_preprocessor.py` → `PreprocessedDocument`
- `entity_resolver.py` → list of `ResolvedMention`

### Downstream

- `event_canonicalizer.py` → merges duplicate events from `EventCandidate`
- `graph_loader.py` → indexes `EvidenceSpan` from `EventCandidate` into `PassageIndex`

### External Dependencies

- `EventExtractionConfig` (`config/settings.py`): confidence threshold and factuality keywords
- `NERConfig.trigger_lexicon` (`config/settings.py`): event trigger dictionary

---

## 5. Position in the Data Flow

```text
[Entity Resolver]
        │  List[ResolvedMention]
        │
[Document Preprocessor]
        │  PreprocessedDocument
        ▼
[Event Extractor]   ← This document
        │  List[EventCandidate]
        ▼
[Event Canonicalizer]
```

---

## 6. Implementation Design Standards

### Single-Document Processing Method

```python
def extract(
    self,
    doc: PreprocessedDocument,
    resolved_mentions: List[ResolvedMention]
) -> List[EventCandidate]
```

It is called sequentially for each document from `main.py`.

```python
all_event_candidates = []
for doc in preprocessed_docs:
    resolved = resolved_by_doc.get(doc.canonical_doc_id, [])
    events = self.event_extractor.extract(doc, resolved)
    all_event_candidates.extend(events)
```

### Confidence Calculation

```python
base_confidence = trigger_confidence   # trigger_lexicon: 0.70
if subject_entity_id and resolution_status == "resolved":
    base_confidence += 0.15
if factuality == "fact":
    base_confidence += 0.10
if amount or event_time:
    base_confidence += 0.05

final_confidence = min(base_confidence, 1.0)
```

Do not create an `EventCandidate` when confidence is below `event_confidence_threshold(0.50)`.

---

## 7. Design Rationale

**Why assign the subject based on trigger position?**  
In financial news, the company name and the event trigger usually appear in the same sentence or in neighboring sentences. If the system uses the most frequent company mention across the whole document as the subject, it risks confusing simple mention frequency with the real actor. Distance-based assignment is simple but precise.

**Why separate factuality from certainty?**  
`factuality` indicates whether the information is a fact or an interpretation. `certainty` indicates how finalized the event is. The agent's Risk Controller needs these as separate attributes so it can apply rules that distinguish confirmed outcomes from mere possibility.
