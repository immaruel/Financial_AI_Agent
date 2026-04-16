# 02. Online Query Pipeline

## 1. Purpose

The online pipeline is the real-time path executed when a user query arrives. It handles the flow KG exploration → evidence recovery → answer generation, and when the KG lacks relevant information it runs real-time supplemental collection and retries.

From a harness engineering perspective, the goals of the online pipeline are:

- handle most queries **stably without human intervention**
- automatically detect **missing evidence, temporal errors, and risky phrasing**
- respond to failure in the order of **self-repair → safe fallback → human escalation**

---

## 2. Harness-Aware Execution Flow

`FinancialKGPipeline.query(user_query: str) -> Dict`

```text
User query input
        │
        ▼
[Perceive]
  normalize query
  inspect risk context
  confirm agent readiness

        │
        ▼
[Plan]
  QueryPlannerAgent.plan()
  -> QueryPlan

        │
        ▼
[Act]
  GraphRetriever -> EvidenceRetriever -> CausalReasoner
  -> HypothesisChecker -> AnswerComposer -> RiskController
  -> StructuredAnswer

        │
        ▼
[Observe]
  check evidence sufficiency, temporal consistency,
  unsupported claims, and advice risk

        │
        ├─ pass -> return final response
        │
        └─ fail
             │
             ▼
        [Reflect]
          classify by failure taxonomy
          choose repair action

             │
             ▼
        [Iterate]
          - supplement if KG miss
          - retrieval expansion
          - certainty downgrade
          - human escalation
```

---

## 3. Execution Flow in the Current Implementation

### 3.1 Basic Query Handling

```python
if not self.agent_orchestrator:
    self.step4_init_agents()

answer = self.agent_orchestrator.process_query(user_query)
```

Inside `process_query()`, execution follows this order.

```text
QueryPlanner
 -> GraphRetriever
 -> EvidenceRetriever
 -> CausalReasoner
 -> HypothesisChecker
 -> AnswerComposer
 -> RiskController
 -> StructuredAnswer
```

### 3.2 KG Miss Detection and Real-Time Supplement

The default recovery strategy in the current implementation is retry on KG miss.

```python
if not answer.timeline and not answer.related_companies:
    asyncio.get_event_loop().run_until_complete(
        self._online_supplement(user_query)
    )
    self.step4_init_agents()
    answer = self.agent_orchestrator.process_query(user_query)
```

This strategy is meant for cases where the information required by the query is not present in the graph at all.

---

## 4. Inputs, Outputs, Success Conditions, and Failure Conditions by Stage

| Stage | Input | Output | Success condition | Failure condition |
|------|-------|--------|-------------------|------------------|
| Query Planner | raw query | `QueryPlan` | intent, entity, and temporal scope are structured correctly | intent misclassification, missing entity or time |
| Graph Retriever | `QueryPlan`, KG | `SubGraphResult` | sufficient recovery of seeds and relevant subgraph | too many irrelevant nodes, missing gold seed |
| Evidence Retriever | subgraph, PassageIndex | `List[EvidenceResult]` | source evidence is available for core claims | insufficient evidence, contradiction not included |
| Causal Reasoner | subgraph + evidence | `CausalChain` | temporal and causal consistency is preserved | reversed event order, overstated causality |
| Hypothesis Checker | chain + evidence | verification verdict | unsupported claims and contradictions are detected | missed validation failures |
| Answer Composer | plan + evidence + chain + verdict | draft answer | citation alignment and fact vs. interpretation distinction hold | unsupported summary, numeric error |
| Risk Controller | draft answer | final answer | risky phrases are controlled and warnings included | investment-advice exposure, excessive refusal |

---

## 5. Constraint Layer

The online agent layer uses the following constraints.

| Rule | Description |
|------|-------------|
| do not assert freshness without evidence | avoid definitive "recent/current" phrasing when freshness is not guaranteed |
| do not compose without retrieval | do not draft an answer when evidence is absent |
| restrict speculative statements | forecasts are allowed only with evidence and hedge wording |
| prohibit high-risk financial advice | forbid buy/sell recommendations, guaranteed return, and deterministic forecasts |
| limit retry budget | self-repair must stop after a fixed number of attempts |

These constraints are especially important in finance because the target is not a merely plausible answer, but one whose evidence and uncertainty are explicitly managed.

---

## 6. Verification Layer

Online validation should include the following.

### 6.1 Planner / Retrieval Validation

- `intent classification accuracy`
- `entity phrase extraction accuracy`
- `temporal constraint extraction accuracy`
- `seed precision / recall`
- `subgraph recall@k`
- `irrelevant node ratio`

### 6.2 Evidence Validation

- `evidence recall@k`
- `evidence precision@k`
- `citation coverage`
- `contradiction recall`

### 6.3 Reasoning / Answer Validation

- `temporal consistency`
- `unsupported claim rate`
- `causal overclaim rate`
- `numeric accuracy`
- `citation alignment`
- `advice risk score`

Recommended operating rules:

- every core claim should have at least one direct supporting item
- when contradiction evidence exists, include it in the answer
- if support for a causal claim is weak, downgrade it to language such as possibility or market interpretation
- attach explicit confidence or warnings to low-confidence answers

---

## 7. Feedback Loop Layer

Self-repair in the online layer should ideally operate in the following order.

### 7.1 Recovery Priority

1. if it is a `KG Miss`, run supplemental collection
2. if the seed is ambiguous, expand retrieval or retry alias search
3. if evidence is insufficient, reduce the number of claims and rebuild the answer conservatively
4. if there is temporal mismatch, re-rank with the newest documents first and reevaluate
5. if risk validation fails, downgrade the wording
6. if failures repeat, escalate to human review

### 7.2 Link to the Failure Taxonomy

Online failures should be tagged with one or more of the following:

- F1 entity confusion
- F2 temporal error
- F3 numeric error
- F5 missing evidence
- F6 overstated reasoning
- F7 safety error
- F8 over-defensiveness

This classification is required to separate retrieval bottlenecks from reasoning bottlenecks.

---

## 8. Trace / Observability

The online harness should store at least the following trace.

### 8.1 Query trace

- raw query
- normalized query
- planner output
- temporal constraints
- target entities

### 8.2 Retrieval trace

- seed nodes
- retrieved nodes and edges
- pruning result
- retrieval score or rank signal

### 8.3 Evidence trace

- selected evidence IDs
- evidence snippets
- whether contradiction evidence was included

### 8.4 Answer trace

- checker verdict
- final answer
- cited evidence IDs
- risk flags
- latency
- token cost

Without this trace, the team only learns that the answer was wrong, not why it was wrong.

---

## 9. Human-in-the-Loop Design

Human intervention should occur only in the following situations.

| Condition | Example |
|-----------|---------|
| high-risk decision | investment-advice-like queries, regulatory or legal interpretation, sensitive market outlook |
| low-confidence output | entity ambiguity, evidence insufficiency, temporal uncertainty |
| system failure | repeated self-repair failure, persistent KG miss even after supplement |

Recommended escalation outcomes:

- `safe_answer`: return a limited answer while stating the information gap
- `review_ticket`: pass trace and failure class so a human can review it

---

## 10. LLM Usage Points

In the current implementation, the main LLM call in the online pipeline happens in `AnswerComposerAgent`.

| Component | Current implementation | Harness extension perspective |
|-----------|------------------------|-------------------------------|
| `AnswerComposerAgent` | always used | grounded answer generation |
| `HypothesisCheckerAgent` | rule / LLM hybrid possible | unsupported claim and contradiction detection |
| `EntityTypeClassifier` fallback | currently not used or optional | future low-confidence typing support |

Core principles:

- do not let the LLM lead the answer without retrieval and evidence
- always pass LLM output through the verification layer
- let Risk Controller remain the final authority on safety

---

## 11. CI/CD Gates and Operational Metrics

Before deployment, the online pipeline should prioritize the following metrics.

- Accuracy
- Faithfulness
- Consistency
- Latency
- Cost
- Safety / Compliance

Example concrete metrics:

- `factual_accuracy`
- `evidence_grounding_score`
- `temporal_accuracy`
- `unsupported_claim_rate`
- `latency_p95`
- `token_cost_per_query`
- `compliance_pass_rate`

Examples of hard gates:

- unsupported claims spike
- advice risk score worsens
- temporal consistency drops sharply

Examples of soft gates:

- latency increases
- cost increases
- slight decline in conciseness or readability

---

## 12. Design Rationale

**Why not let self-repair loop forever?**  
Real-time supplemental collection does not guarantee that relevant information will always be found. Unlimited retries inflate response latency and cost. After a fixed number of attempts, safe failure or human review is the better choice.

**Why include contradiction evidence?**  
In finance, opposite interpretations of the same event are common. A system that sees only supportive evidence can still sound convincing while being risky.

**Why is online trace important?**  
Improvement moves faster when the team can separate retrieval failures, reasoning failures, and answer-composition failures. Without trace, regressions may be visible, but their causes are much harder to identify.
