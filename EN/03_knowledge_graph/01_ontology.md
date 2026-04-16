# 01. Ontology Definition

## 1. Purpose

Define the core entities and relationships of the financial domain by **separating static knowledge from dynamic events**. This ontology specifies which nodes and edges may exist in the KG and serves as the standard that converts preprocessing outputs into graph structure.

Design reference: the core ideas of FIBO, the Financial Industry Business Ontology, are reinterpreted here for financial event analysis.

From a harness engineering perspective, the ontology is not just a concept definition. It is a **key reference file for both the Constraint Layer and the Context Layer**. In other words, it determines not only which node and edge combinations are allowed, but also which combinations are forbidden and what validation is required.

---

## 2. Overall Structure

```text
┌──────────────────────────────────────────────────────┐
│                    Static Entity Layer              │
│                                                      │
│  Company  Industry  Region  Institution  Commodity   │
└──────────────────────────────────────────────────────┘
                         │
            Structural relation edges (BELONGS_TO, SUPPLIES_TO, etc.)
                         │
┌──────────────────────────────────────────────────────┐
│                    Dynamic Event Layer              │
│                                                      │
│                       Event                          │
│   (ContractEvent, EarningsEvent, M&AEvent, ...)     │
└──────────────────────────────────────────────────────┘
                         │
           Evidence relation edges (SUPPORTED_BY, FROM_DOCUMENT, etc.)
                         │
┌──────────────────────────────────────────────────────┐
│                  Evidence / Source Layer            │
│                                                      │
│                Evidence          Document            │
└──────────────────────────────────────────────────────┘
```

The static layer provides the structural context of companies, the dynamic layer stores events that accumulate over time, and the evidence layer connects every claim back to the source text.

---

## 3. Node Definitions

### 3.1 Static Entity Layer

#### Company

The canonical entity produced by Company Entity Resolution. This is the most central node type in the KG.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `canonical_entity_id` | ✓ | Unique key across the full system |
| `name` | ✓ | Official company name |
| `ticker` | | Ticker symbol |
| `corp_code` | | DART corporation code |
| `exchange` | | Listing exchange |
| `country` | | Country of registration |

Source: Entity Resolution output plus DART reference data

#### Industry

The industry a company belongs to. Loaded from industry classification reference data. Industries inferred only from article context are not loaded.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `industry_id` | ✓ | Industry classification ID |
| `name` | ✓ | Industry name |
| `taxonomy_source` | | Source of the taxonomy |

#### Region

Represents company regional exposure or the geographic scope of an event. Usually linked to Company via `EXPOSED_TO_REGION`.

#### Institution

Represents government agencies, central banks, regulators, financial institutions, and similar bodies.

#### Commodity

Represents raw materials or traded goods produced or used by companies. Connected to Company through edges such as `USES_COMMODITY` and `PRODUCES`.

---

### 3.2 Dynamic Event Layer

#### Event

The node form of `CanonicalEvent`, produced by Event Canonicalization. This is the core query unit in the KG.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `canonical_event_id` | ✓ | Unique event key |
| `event_type` | ✓ | Leaf event type |
| `event_time` | ✓ | Occurrence time, falling back to `published_at` when missing |
| `event_subtype` | | Higher-level category |
| `effective_time` | | Effective time |
| `polarity` | | positive / negative / neutral / mixed |
| `certainty` | | disclosed / reported / estimated / speculated |
| `confidence` | | Extraction confidence |

**Event type hierarchy:**

```text
CorporateAction
  ├── ContractEvent      (contracts, order wins, MOUs, partnerships)
  ├── DividendEvent      (dividends, cash dividends)
  ├── BuybackEvent       (treasury stock, cancellation)
  ├── M&AEvent           (acquisition, merger, equity purchase)
  └── CapitalEvent       (rights offerings, convertible bonds)

FinancialResult
  ├── EarningsEvent      (revenue, operating profit, earnings)
  ├── GuidanceChange     (guidance, outlook revision)
  └── CreditEvent        (credit rating changes)

ExternalShock
  ├── RegulationEvent    (sanctions, penalty surcharges, corrective orders)
  ├── PolicyAnnouncement (policy releases, subsidies)
  ├── MacroRelease       (interest rates, exchange rates, GDP)
  └── SupplyDisruption   (supply disruptions, production stoppages, recalls)

SpecialEvent
  ├── LawsuitEvent       (lawsuits, patent disputes)
  ├── DelistingRisk      (delisting risk)
  ├── RatingChange       (credit rating adjustment)
  ├── ManagementChange   (executive appointment/resignation, reorganization)
  └── LaborEvent         (strikes, labor disputes)
```

---

### 3.3 Evidence / Source Layer

#### Evidence

A sentence-level span from the original text that supports an event. This is loaded from `EvidenceSpan` in `event_extractor.py`.

| Attribute | Required | Description |
|-----------|----------|-------------|
| `evidence_id` | ✓ | Unique key |
| `text` | ✓ | Original text |
| `canonical_doc_id` | | Source document ID |
| `sentence_id` | | Source sentence ID |
| `char_start` / `char_end` | | Offsets in the original text |
| `extraction_method` | | Extraction method |
| `confidence` | | Extraction confidence |

#### Document

A node form of `CanonicalDocument`. It is connected to Evidence through the `FROM_DOCUMENT` edge.

---

## 4. Edge Definitions

### Structural Relations, Static

| Edge type | Source | Target | Creation condition |
|-----------|--------|--------|--------------------|
| `BELONGS_TO_INDUSTRY` | Company | Industry | reference-data mapping exists |
| `LISTED_ON` | Company | Region | based on exchange location |
| `SUBSIDIARY_OF` | Company | Company | ownership structure data |
| `SUPPLIES_TO` | Company | Company | supply-chain evidence accumulation |
| `EXPOSED_TO_REGION` | Company | Region | regional exposure evidence |
| `USES_COMMODITY` | Company | Commodity | raw-material dependency evidence |

### Event Relations, Dynamic

| Edge type | Source | Target | Creation condition |
|-----------|--------|--------|--------------------|
| `HAS_EVENT` | Company | Event | based on `canonical_event.subject_entity_id` |
| `HAS_EVENT_CANDIDATE` | Company | EventCandidate | candidate stage before canonicalization |
| `INVOLVES` | Event | Company/Institution/Region/Commodity | object or related slot exists |
| `AFFECTS` | Event | Company/Industry | impact target was inferred or extracted |
| `PRECEDES` | Event | Event | temporal ordering plus same company or same event family |
| `CAUSED_BY` | Event | Event | sufficient causal evidence exists |
| `CANONICALIZED_TO` | EventCandidate | Event | canonicalization result |

### Evidence / Verification Relations

| Edge type | Source | Target | Creation condition |
|-----------|--------|--------|--------------------|
| `SUPPORTED_BY` | Event | Evidence | evidence span exists |
| `FROM_DOCUMENT` | Evidence | Document | document alignment complete |
| `DISCLOSED_IN` | Event | Document | `source_type == "filing"` |
| `REPORTED_IN` | Event | Document | `source_type == "news"` |
| `OBSERVED_IN` | EventCandidate | Document | candidate-stage document link |

---

## 5. Core Relation Patterns

The most frequently explored paths in financial analysis:

```cypher
-- Retrieve recent events for a company
(Company)-[:HAS_EVENT]->(Event)

-- Recover source evidence for an event
(Event)-[:SUPPORTED_BY]->(Evidence)-[:FROM_DOCUMENT]->(Document)

-- Track temporal chains across events
(Event1)-[:PRECEDES]->(Event2)-[:PRECEDES]->(Event3)

-- Screen companies within an industry
(Company)-[:BELONGS_TO_INDUSTRY]->(Industry)

-- Analyze policy impact
(Policy)-[:AFFECTS]->(Industry)<-[:BELONGS_TO_INDUSTRY]-(Company)
```

---

## 6. Design Rationale

### 6.1 Role from the Harness Perspective

The ontology serves the following three roles in the harness.

| Role | Description |
|------|-------------|
| Context Layer | Shared semantic system referenced by planner, retriever, and graph loader |
| Constraint Layer | Blocks forbidden node/edge combinations, incorrect attribution, and unsupported relation creation |
| Verification Layer | Provides the standard for ontology violation count, orphan ratio, and stale edge rate |

Representative validation points:

- Whether Events are being created without a Company
- Whether there are too many Events without Evidence
- Whether `PRECEDES` or `CAUSED_BY` is being created between disallowed types
- Whether Region, Institution, or Commodity nodes are connected through invalid edges

Representative failure types:

- F1 entity confusion
- F4 event attribution error
- F5 missing evidence

---

**Why separate static and dynamic layers?**  
A company's industry affiliation, static, and a company's recent contract signing, dynamic, have completely different update cycles and query patterns. Separating them lets the system update the fast-moving event layer intensively while using the stable structure layer almost like a cache.

**Why keep both EventCandidate and CanonicalEvent in the graph?**  
The agent should be able to reference not only canonicalized events but also individual document-level candidates. Keeping both `HAS_EVENT_CANDIDATE` and `CANONICALIZED_TO` makes it possible for the Evidence Retriever to cross-check multiple reports of the same event.
