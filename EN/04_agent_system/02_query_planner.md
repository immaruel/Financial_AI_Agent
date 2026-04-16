# 02. Query Planner Agent

## 1. Purpose

Convert a user's natural-language query into a structured `QueryPlan` that can drive graph retrieval.

It is composed of four stages: query normalization, time-expression parsing, intent classification, and entity extraction. All processing is rule-based, using regexes and dictionaries, with no LLM involved.

From a harness engineering perspective, Query Planner is the **first failure localization point in the online pipeline**. Retrieval and reasoning quality both depend heavily on planner output quality, so the planner must always be covered by trace and validation metrics.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `query: str` | User natural-language query |
| `AgentConfig` | Intent keyword dictionary and time-expression dictionary |
| `entity_dict: Dict[str, str]` | `{company_name: canonical_entity_id}`, built from reference data during agent initialization |

### Output

`QueryPlan` (`utils/schemas.py`)

| Field | Type | Description |
|------|------|-------------|
| `original_query` | str | Original query |
| `normalized_query` | str | Normalized query |
| `query_intents` | List[str] | Detected intent list |
| `primary_intent` | str | Primary intent |
| `secondary_intent` | str | Secondary intent |
| `time_constraints` | Dict | Time range such as `from_date`, `to_date`, `window_days` |
| `entity_phrases` | List[Dict] | Matched entities, `text`, `entity_id`, `source` |
| `raw_phrases` | List[str] | Unmatched noun-like tokens |

---

## 3. Processing Logic

### 3.1 Query Normalization

```python
def _normalize_query(self, query: str) -> str:
    q = query.strip()
    q = re.sub(r"\s+", " ", q)           # normalize repeated spaces
    q = re.sub(r"[?？!！]+$", "", q)     # remove sentence-final punctuation
    q = re.sub(r"\(([^)]*)\)", r" \1 ", q)  # expand parenthetical expressions
    q = re.sub(r"[~\-–—]+", " ", q)     # normalize dash variants into spaces
    return q.strip()
```

Korean particles are not removed. Without a true Korean grammar analyzer, stripping particles can damage noun boundaries.

### 3.2 Time-Expression Extraction

Search the query for time expressions defined in `AgentConfig.temporal_expressions`.

| Expression | window_days |
|------------|-------------|
| today | 0 |
| yesterday | 1 |
| this week | 7 |
| recent | 30 |
| last 3 months | 90 |
| this year | 365 |

```python
for expr, days in self.config.temporal_expressions.items():
    if expr in text:
        constraints = {
            "expression": expr,
            "from_date": (now - timedelta(days=days)).isoformat(),
            "to_date": now.isoformat(),
            "window_days": days,
        }
        break
```

If no time expression is found, apply a default 30-day window. Year and month patterns such as `2024` or `March` are extracted with separate regexes and stored in `constraints["year"]` and `constraints["month"]`.

### 3.3 Query Intent Classification

```python
query_intent_keywords = {
    "fact_lookup":        ["what", "how much", "which", "when", "who"],
    "impact_analysis":    ["impact", "benefit", "damage", "affect", "spillover", "effect"],
    "timeline_summary":   ["organize", "flow", "timeline", "order", "progress"],
    "company_screening":  ["stock", "company", "screening", "filter"],
    "event_summary":      ["recent", "what happened", "what event", "incident"],
    "comparison":         ["compare", "difference", "versus", "vs"],
    "policy_tracking":    ["policy", "regulation", "bill", "system"],
}
```

Because a single query can contain multiple intents, the planner stores both `primary_intent` and `secondary_intent`.

### 3.4 Entity Extraction

This runs in two steps.

**Step 1: Match through `entity_dict`**

Match longer names first, sorting by descending string length, to avoid duplicate matches caused by containment.

```python
for name, eid in sorted(entity_dict.items(), key=lambda x: len(x[0]), reverse=True):
    if name in text and eid not in seen_entity_ids:
        entity_phrases.append({"text": name, "entity_id": eid, "source": "dict"})
        seen_entity_ids.add(eid)
```

**Step 2: Extract `raw_phrases`, unmatched noun-like tokens**

Extract Korean and English tokens that did not match `entity_dict`. Remove particle patterns and filter stopwords.

```python
stopwords = {
    "recent", "latest", "what", "tell me", "organize", "summary", "related", "news", "trend", ...
}
particle_pattern = re.compile(
    r"(으로부터|으로는|에서는|에게|으로|까지|부터|은|는|이|가|을|를|와|과|도|에|의)$"
)
```

`raw_phrases` are later used by Graph Retriever for partial-string and fuzzy seed matching.

---

## 4. Dependencies and Connected Modules

### Upstream

- user input string
- `AgentConfig` (`config/settings.py`)
- `entity_dict`, built from `ReferenceDataManager` during `step4_init_agents()`

### Downstream

- `GraphRetrieverAgent.retrieve(plan)` → receives `QueryPlan`

---

## 5. Position in the Data Flow

Agent pipeline **Step 1 / 7**. The only input is the raw user query string, and every later agent uses the resulting `QueryPlan` as shared context.

```text
User query
        │
        ▼
[QueryPlannerAgent]   ← This document (Step 1 / 7)
        │  QueryPlan
        ▼
[GraphRetrieverAgent]  (Step 2 / 7)
```

---

## 6. Verification Points from the Harness Perspective

Query Planner should be validated on the following dimensions.

| Item | Meaning |
|------|---------|
| `intent classification accuracy` | whether query intent classification is correct |
| `entity phrase extraction accuracy` | whether core company, industry, and policy phrases were captured |
| `temporal constraint extraction accuracy` | whether time scopes like recent, this year, or last 3 months were parsed correctly |
| `query decomposition quality` | whether composite queries were decomposed well into primary and secondary intent |

Planner trace should at minimum include:

- raw query
- normalized query
- `query_intents`
- primary / secondary intent
- extracted entities
- temporal constraints
- low-confidence parsing flag

Representative failure types:

- F1 entity confusion
- F2 temporal error
- F8 over-defensive or overly compressed interpretation

---

## 7. Implementation Design Standards

### Building `entity_dict`, Run Once in `step4_init_agents`

```python
entity_dict = {}
for comp in self.ref_data.companies.values():
    entity_dict[comp.name] = comp.canonical_entity_id
    for alias in comp.aliases:
        entity_dict[alias] = comp.canonical_entity_id

self.agent_orchestrator = AgentOrchestrator(
    config=self.config.agent,
    graph_store=self.graph_store,
    llm_client=self.llm_client,
    entity_dict=entity_dict,
)
```

If real-time supplemental collection happens after a KG miss and `step4_init_agents()` is called again, `entity_dict` is updated as well.

---

## 8. Design Rationale

**Why not parse the query with an LLM?**  
Using an LLM for query parsing increases latency and makes outputs non-deterministic. The core patterns in financial queries, time expressions, company names, and intent keywords, are well covered by dictionaries and regexes. LLM capacity is reserved for answer generation in Answer Composer instead.

**Why use a primary plus secondary intent structure?**  
A query like "compare Hyundai Motor's recent earnings with its competitors" contains both `event_summary` as the primary intent and `comparison` as the secondary intent. If only one intent is allowed, hop count and edge type choice in Graph Retriever become incomplete for these composite queries.
