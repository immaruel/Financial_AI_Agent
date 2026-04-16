# 05. Causal Reasoner Agent

## 1. Purpose

Accept the event nodes in `SubGraphResult` together with `EvidenceResult`, then **reconstruct the events in temporal and causal order** to produce `CausalChain`.

Rather than merely listing events, this stage builds a chain that reflects both temporal ordering through `PRECEDES` edges and influence relations through `CAUSES` and `AFFECTS` edges.

From a harness engineering perspective, Causal Reasoner is the **point where a financial AI agent can most easily overclaim**, so it must be monitored strictly and separately from retrieval quality.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `SubGraphResult` | Retrieved nodes, including events, plus edges |
| `List[EvidenceResult]` | Source evidence for each event |
| `AgentConfig` | Time-related configuration |

### Output

`CausalChain` (`utils/schemas.py`)

| Field | Type | Description |
|------|------|-------------|
| `events` | List[Dict] | Event list sorted in temporal order |
| `causal_links` | List[Dict] | List of causal or temporal links |
| `confidence_level` | str | `observed` / `likely` / `hypothesis` / `confirmed` |

Structure of each `causal_links` item:

```python
{
    "from_event_id": str,
    "to_event_id":   str,
    "link_type":     str,   # "PRECEDES" / "CAUSES" / "AFFECTS"
    "lag_days":      int,
    "confidence":    float,
}
```

---

## 3. Processing Logic

### 3.1 Collect Event Nodes

Separate Event and EventCandidate nodes from `SubGraphResult.nodes`.

### 3.2 Sort by Time

```python
sorted_events = sorted(
    event_nodes,
    key=lambda e: (e.get("event_time") or "", e.get("confidence", 0.0)),
    reverse=False
)
```

Events without `event_time` are placed later in the sorted list.

### 3.3 Scan for `PRECEDES` Edges

Extract edges from the subgraph where `edge_type == "PRECEDES"` and convert them into `causal_links`.

```python
for edge in subgraph.edges:
    if edge["type"] == "PRECEDES":
        causal_links.append({
            "from_event_id": edge["source"],
            "to_event_id":   edge["target"],
            "link_type":     "PRECEDES",
            "lag_days":      edge.get("lag_days", 0),
            "confidence":    edge.get("confidence", 1.0),
        })
```

### 3.4 Handle `CAUSED_BY` / `AFFECTS` Edges

When stronger causal evidence exists, convert `CAUSED_BY` and `AFFECTS` into `link_type = "CAUSES"` and `link_type = "AFFECTS"`.

### 3.5 Determine `confidence_level`

Evaluate the aggregate reliability of the full chain.

```python
avg_confidence = mean(e.get("confidence", 0) for e in events)

if avg_confidence >= 0.85 and all_confirmed:
    confidence_level = "confirmed"
elif avg_confidence >= 0.70:
    confidence_level = "observed"
elif avg_confidence >= 0.50:
    confidence_level = "likely"
else:
    confidence_level = "hypothesis"
```

`confirmed`: majority of events come from filing-backed evidence  
`observed`: mostly news-backed events, but still supported  
`likely`: some events are unverified  
`hypothesis`: most events are unverified or low-confidence

---

## 4. Dependencies and Connected Modules

### Upstream

- `GraphRetrieverAgent` → `SubGraphResult`
- `EvidenceRetrieverAgent` → `List[EvidenceResult]`

### Downstream

- `HypothesisCheckerAgent` → checks unsupported inference in the chain
- `RiskControllerAgent` → validates `CausalChain.confidence_level` and per-event certainty
- `AnswerComposerAgent` → builds the timeline from `CausalChain.events`

---

## 5. Position in the Data Flow

Agent pipeline **Step 4 / 7**. It receives the outputs of both Graph Retriever and Evidence Retriever and reconstructs them into a temporal and causal chain.

```text
[GraphRetrieverAgent] (Step 2)  +  [EvidenceRetrieverAgent] (Step 3)
        │  SubGraphResult + List[EvidenceResult]
        ▼
[CausalReasonerAgent]   ← This document (Step 4 / 7)
        │  CausalChain
        ├──→ [HypothesisCheckerAgent] (Step 5 / 7)
        ├──→ [AnswerComposerAgent]    (Step 6 / 7)
        └──→ [RiskControllerAgent]    (Step 7 / 7)
```

---

## 6. Verification Points from the Harness Perspective

Causal Reasoner should be validated on the following dimensions.

| Item | Meaning |
|------|---------|
| `temporal_order_consistency` | whether event order has been preserved correctly |
| `causal_chain_validity` | whether `CAUSES` and `AFFECTS` links match graph evidence |
| `unsupported_inference_rate` | whether causality is overstated without evidence or edges |
| `hedge_calibration_score` | whether the answer's level of certainty matches the chain confidence |

Reasoning trace should include:

- sorted event sequence
- used `PRECEDES`, `CAUSED_BY`, and `AFFECTS` edges
- rejected causal hypotheses
- chain-level confidence

Representative failure types:

- F2 temporal error
- F6 overstated reasoning
- upstream causes of F7 safety error

---

## 7. Implementation Design Standards

### Prevent Causal Leap

`PRECEDES` indicates only temporal order. To prevent it from being misread as causality, `causal_links.link_type` explicitly distinguishes relation meaning.

- `PRECEDES`: only temporal order is confirmed, no causal claim
- `CAUSES`: a `CAUSED_BY` edge exists, so causal support is present
- `AFFECTS`: an `AFFECTS` edge exists, so impact support is present

Answer Composer varies its wording according to this type.

---

## 8. Design Rationale

**Why not use an LLM for causal reasoning?**  
If an LLM invents causal relations freely, unverified causal leaps can enter the final answer. By using only graph edges that already exist, such as `CAUSED_BY` and `PRECEDES`, every causal claim in the answer remains tied to extracted data.

**Why use four confidence levels?**  
Risk Controller needs a chain-level reliability estimate so it can enforce the distinction between confirmed outcomes and possibility. A four-level scale is more useful than a simple trust/don't-trust binary for controlling answer tone.
