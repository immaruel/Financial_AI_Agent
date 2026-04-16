# 01. Agent System Architecture

## 1. Purpose

Define the **multi-agent pipeline** that accepts a user's natural-language query, explores the KG, and generates an evidence-grounded structured answer.

This document does more than list the agents in the system. From a harness engineering perspective, it also defines:

- the input and output of each agent
- success and failure conditions
- validation points in the execution loop
- trace collection standards
- criteria for self-repair and human escalation

---

## 2. Agent List and Roles

The current system treats the following seven components as its logical execution units.

| Component | Class | Role |
|-----------|-------|------|
| Query Planner | `QueryPlannerAgent` | Convert natural-language query into structured `QueryPlan` |
| Graph Retriever | `GraphRetrieverAgent` | Convert `QueryPlan` into `SubGraphResult` |
| Evidence Retriever | `EvidenceRetrieverAgent` | Convert `SubGraphResult` into `EvidenceResult` |
| Causal Reasoner | `CausalReasonerAgent` | Convert subgraph plus evidence into `CausalChain` |
| Hypothesis Checker | `HypothesisCheckerAgent` | Check unsupported claims and contradictions in reasoning output |
| Answer Composer | `AnswerComposerAgent` | Integrate all intermediate results into a draft `StructuredAnswer` |
| Risk Controller | `RiskControllerAgent` | Post-process the final answer for investment phrasing, overconfidence, and high-risk output |

> `HypothesisCheckerAgent` is a logical validator for reasoning output, while `RiskControllerAgent` is the policy filter that governs end-user safety. Because their purposes differ, the harness also manages them separately.

---

## 3. Depth-First Task Decomposition

The top-level goal is to "return an evidence-grounded answer to a financial query in a reliable way." Broken down depth-first into the smallest executable tasks, it becomes:

```text
Goal: Generate a structured answer for a financial query
  ├─ T1. Understand the query
  │    └─ query normalization, intent classification, entity/time extraction
  ├─ T2. Explore the graph
  │    └─ seed discovery, subgraph retrieval, temporal pruning
  ├─ T3. Recover evidence
  │    └─ choose passages and document evidence, check contradiction coverage
  ├─ T4. Reason
  │    └─ timeline ordering, causal linking, unsupported inference checks
  ├─ T5. Compose the answer
  │    └─ evidence-grounded summary, citation alignment, confidence calculation
  └─ T6. Control risk
       └─ suppress investment advice, speculative phrasing, and low-confidence output
```

The specification of each task is as follows.

| Task | Input | Output | Success condition | Failure condition |
|------|-------|--------|-------------------|------------------|
| T1. Query understanding | `query` | `QueryPlan` | intent, entity, and temporal scope are consistent with the query | intent misclassification, missing entity, failed time extraction |
| T2. Graph exploration | `QueryPlan`, KG | `SubGraphResult` | required seeds and relevant subgraph are retrieved with enough coverage | too many low-relevance nodes, missing gold seed |
| T3. Evidence recovery | `SubGraphResult`, PassageIndex | `List[EvidenceResult]` | evidence is available for core claims | missing citations, missing contradictory evidence |
| T4. Reasoning | subgraph + evidence | `CausalChain`, verification input | temporal and causal links are formed without exaggeration | reversed event order, treating correlation as causation |
| T5. Answer composition | plan + evidence + chain + checker verdict | draft `StructuredAnswer` | fact vs. interpretation distinction is preserved and citations stay aligned | unsupported claims inserted, numbers or timestamps distorted |
| T6. Risk control | draft `StructuredAnswer` | filtered final answer | suppresses investment advice and overconfidence, attaches low-confidence warnings | degraded usefulness or insufficient safety |

---

## 4. Overall Execution Flow

```text
User query (str)
        │
        ▼
[1] QueryPlannerAgent.plan()
        │  QueryPlan
        ▼
[2] GraphRetrieverAgent.retrieve()
        │  SubGraphResult
        ▼
[3] EvidenceRetrieverAgent.retrieve_evidence()
        │  List[EvidenceResult]
        ▼
[4] CausalReasonerAgent.reason()
        │  CausalChain
        ▼
[5] HypothesisCheckerAgent.check()
        │  verification verdict
        ▼
[6] AnswerComposerAgent.compose()
        │  StructuredAnswer draft
        ▼
[7] RiskControllerAgent.check_and_filter()
        │  StructuredAnswer
        ▼
Return final answer
```

`AgentOrchestrator` in `agent/agents.py` runs the sequence above.

```python
class AgentOrchestrator:
    def __init__(self, config, graph_store, llm_client, entity_dict):
        self.query_planner = QueryPlannerAgent(config, entity_dict)
        self.graph_retriever = GraphRetrieverAgent(config, graph_store)
        self.evidence_retriever = EvidenceRetrieverAgent(graph_store)
        self.causal_reasoner = CausalReasonerAgent(graph_store)
        self.hypothesis_checker = HypothesisCheckerAgent(llm_client)
        self.answer_composer = AnswerComposerAgent(llm_client)
        self.risk_controller = RiskControllerAgent(config)

    def process_query(self, query: str) -> StructuredAnswer:
        plan = self.query_planner.plan(query)
        subgraph = self.graph_retriever.retrieve(plan)
        evidence = self.evidence_retriever.retrieve_evidence(subgraph)
        chain = self.causal_reasoner.reason(subgraph)
        verification = self.hypothesis_checker.check(chain, evidence)
        answer = self.answer_composer.compose(plan, subgraph, evidence, chain, verification)
        answer = self.risk_controller.check_and_filter(answer)
        return answer
```

---

## 5. Execution Loop

Execution in the online agent layer can be interpreted through the following loop.

| Stage | Meaning | Input | Output | Failure handling |
|------|---------|-------|--------|------------------|
| Perceive | Understand the query and current KG state | raw query, policy, KG state | normalized query, risk context | safe fallback on query parsing failure |
| Plan | Structure the query | normalized query, context bundle | `QueryPlan` | conservative temporal/entity interpretation if low-confidence |
| Act | Run retrieval, reasoning, composition | `QueryPlan`, graph store | subgraph, evidence, chain, draft answer | supplement or expand retrieval on KG miss |
| Observe | Validate intermediate outputs | intermediate outputs | validation result | detect unsupported claims and temporal mismatch |
| Reflect | Analyze root cause after failure | validation result, trace | repair decision | tag the error location using the failure taxonomy |
| Iterate | Retry or terminate | repair decision | corrected answer or escalation | human review if retry limit is exceeded |

---

## 6. Constraint Layer

At the agent layer, the following boundaries are kept explicit.

| Rule | Description |
|------|-------------|
| Query Planner does not call external APIs directly | the planner focuses only on structuring the query |
| Graph Retriever explores only allowed edge types and hop ranges | prevents retrieval noise from exploding |
| Evidence Retriever uses only PassageIndex and graph evidence | forbids invented evidence |
| Causal Reasoner does not assert direct causality without evidence | prevents overclaiming |
| Answer Composer cannot ignore the verification verdict | unsupported claims must be hedged or abstained from |
| Risk Controller always runs before the final response | acts as the safety and compliance gate |

Finance-specific constraints are added on top.

- prohibit direct investment recommendations
- prohibit extreme certainty expressions such as "certain," "guaranteed," and "must"
- when freshness is insufficient, specify the reference time or use conservative phrasing
- when entity resolution ambiguity is high, include uncertainty warnings instead of definitive wording

---

## 7. Context Layer

Ideally, the information agents must always reference is managed not as prose alone but as structured context assets.

Recommended assets:

| Asset | Role |
|------|------|
| ontology / schema snapshot | event types, entity types, edge constraints |
| prompt bundle version | version management for query interpretation and answer templates |
| eval slice definition | categorization of fact, temporal, causal, and safety queries |
| failure taxonomy | F1 through F8 error categories |
| risk policy | forbidden phrases and low-confidence handling rules |

This document describes those assets conceptually, assuming they will later be materialized in executable harness formats.

---

## 8. Trace / Observability

The harness must collect the following trace.

### 8.1 Query-Level Trace

- raw user query
- normalized query
- planner output
- confidence / risk class

### 8.2 Retrieval Trace

- seed node IDs
- retrieved node and edge IDs
- graph size before and after pruning
- temporal filter results
- whether gold seeds were missing

### 8.3 Evidence Trace

- selected evidence IDs
- evidence ranking signals
- evidence text snippets
- whether contradiction evidence was included

### 8.4 Reasoning / Answer Trace

- generated hypotheses
- accepted / rejected hypotheses
- checker verdict
- final answer
- cited evidence IDs
- risk flags
- latency / token cost

Without this trace, the system cannot automatically answer "why it failed" or separate retrieval failures from reasoning failures.

---

## 9. Verification Layer

The core validation points in the online layer are:

| Validation item | Description |
|-----------------|-------------|
| intent / entity / temporal consistency | whether the planner interpreted the query structure correctly |
| subgraph relevance | whether the required seeds and edges were retrieved |
| evidence sufficiency | whether each key claim has the minimum evidence count |
| contradiction inclusion | whether counter-evidence was retrieved when it exists |
| temporal consistency | whether event order and timestamps were preserved |
| unsupported claim rate | rate of claims without evidence |
| advice risk score | level of investment-advice-like or overconfident phrasing |

Recommended policy behavior:

- if a core claim has no evidence, downgrade the answer or abstain
- if contradiction evidence exists, include both sides in the summary
- if causal phrasing lacks at least two independent supporting sources, weaken it with hedging language

---

## 10. Failure Cases and Recovery

Representative failure cases and recovery strategies:

| Failure case | Candidate cause | Recovery |
|--------------|-----------------|----------|
| KG miss | missing seed, poor subgraph recall | supplemental collection, retrieval expansion, retry |
| evidence-poor answer | insufficient evidence retrieval | re-search evidence, shrink claims, abstain |
| temporal error | failed temporal parsing, outdated evidence | re-rank latest documents first, state the reference date |
| overstated causality | checker rejection, insufficient evidence | downgrade causal claims to possibility or interpretation |
| risky phrasing detected | wording overstated by Answer Composer | post-process in Risk Controller and add warnings |

Self-repair is not allowed to loop forever. If retries accumulate under the same failure class, the system should escalate to human review or terminate with a safe failure.

---

## 11. Human-in-the-Loop

Request human intervention only under the following conditions.

- high-risk decision
- low-confidence output
- repeated system failure

More concrete trigger examples:

- high entity ambiguity with direct impact on the core answer
- evidence sufficiency below threshold
- checker strongly flags contradiction or unsupported claims
- risk controller repeatedly detects investment-advice-like language

---

## 12. Related Documents

- [02_query_planner.md](02_query_planner.md)
- [03_graph_retriever.md](03_graph_retriever.md)
- [04_evidence_retriever.md](04_evidence_retriever.md)
- [05_causal_reasoner.md](05_causal_reasoner.md)
- [06_risk_controller_and_answer_composer.md](06_risk_controller_and_answer_composer.md)
- [../06_pipeline_runtime/02_online_query_pipeline.md](../06_pipeline_runtime/02_online_query_pipeline.md)
