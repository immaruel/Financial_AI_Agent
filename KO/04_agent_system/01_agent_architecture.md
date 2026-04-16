# 01. 에이전트 시스템 아키텍처 (Agent Architecture)

## 1. 목적

사용자의 자연어 질의를 받아 KG를 탐색하고, 근거 기반의 구조화된 답변을 생성하는 **다중 에이전트 파이프라인**을 정의한다.

이 문서는 단순히 "어떤 에이전트가 있는가"를 설명하는 데서 끝나지 않는다. 하네스 엔지니어링 관점에서 다음을 함께 정의한다.

- 각 에이전트의 입력과 출력
- 성공 조건과 실패 조건
- 실행 루프에서의 검증 포인트
- trace 수집 규격
- self-repair와 human escalation 기준

---

## 2. 에이전트 목록 및 역할

현재 시스템의 논리적 실행 단위는 아래 7개 컴포넌트로 본다.

| 컴포넌트 | 클래스 | 역할 |
|----------|--------|------|
| Query Planner | `QueryPlannerAgent` | 자연어 질의 → 구조화된 `QueryPlan` |
| Graph Retriever | `GraphRetrieverAgent` | `QueryPlan` → `SubGraphResult` |
| Evidence Retriever | `EvidenceRetrieverAgent` | `SubGraphResult` → `EvidenceResult` |
| Causal Reasoner | `CausalReasonerAgent` | Subgraph + Evidence → `CausalChain` |
| Hypothesis Checker | `HypothesisCheckerAgent` | 추론 결과의 unsupported claim / contradiction 점검 |
| Answer Composer | `AnswerComposerAgent` | 모든 결과 통합 → `StructuredAnswer` 초안 |
| Risk Controller | `RiskControllerAgent` | 투자 표현·과도한 확신·고위험 출력을 후처리 필터링 |

> `HypothesisCheckerAgent`는 reasoning 결과를 검증하는 논리 검증기이고, `RiskControllerAgent`는 최종 사용자 안전성을 제어하는 정책 필터다. 둘은 목적이 다르므로 하네스 설계에서도 별도 관리한다.

---

## 3. Depth-first Task Decomposition

최상위 목표는 "금융 질의에 대해 근거 기반 답변을 안정적으로 반환"하는 것이다. 이를 depth-first 방식으로 실행 가능한 최소 단위까지 쪼개면 아래와 같다.

```text
Goal: 금융 질의에 대한 구조화된 답변 생성
  ├─ T1. 질의 이해
  │    └─ Query 정규화, intent 분류, entity/time 추출
  ├─ T2. 그래프 탐색
  │    └─ seed 탐색, subgraph retrieval, temporal pruning
  ├─ T3. 근거 회수
  │    └─ passage / document evidence 선택, contradiction 포함 여부 점검
  ├─ T4. 추론
  │    └─ timeline 정렬, 인과 연결, unsupported inference 점검
  ├─ T5. 답변 구성
  │    └─ 근거 기반 요약, citation 정렬, confidence 계산
  └─ T6. 위험 제어
       └─ 투자 권유, speculative 표현, low-confidence 출력 제어
```

각 Task의 명세는 다음과 같다.

| Task | 입력 | 출력 | 성공 조건 | 실패 조건 |
|------|------|------|-----------|-----------|
| T1. 질의 이해 | `query` | `QueryPlan` | intent, entity, temporal scope가 질의와 정합 | intent 오분류, entity 누락, 시간 범위 추출 실패 |
| T2. 그래프 탐색 | `QueryPlan`, KG | `SubGraphResult` | 필요한 seed와 관련 서브그래프를 충분히 회수 | 관련성 낮은 노드 과다, gold seed 누락 |
| T3. 근거 회수 | `SubGraphResult`, PassageIndex | `List[EvidenceResult]` | 핵심 주장에 대응하는 evidence 확보 | citation 부족, contradiction evidence 누락 |
| T4. 추론 | subgraph + evidence | `CausalChain`, verification input | 시간순/인과 연결이 과장 없이 구성 | 시간 순서 역전, 상관관계의 인과 단정 |
| T5. 답변 구성 | plan + evidence + chain + checker verdict | `StructuredAnswer` 초안 | 사실/해석 구분, citation alignment 유지 | unsupported claim 삽입, 수치/시점 왜곡 |
| T6. 위험 제어 | `StructuredAnswer` 초안 | 필터링된 최종 답변 | 투자 권유/과도한 확신 억제, 저신뢰 경고 부착 | 유용성 훼손, 안전성 미달 |

---

## 4. 전체 실행 흐름

```text
사용자 질의 (str)
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
최종 답변 반환
```

`agent/agents.py`의 `AgentOrchestrator`는 위 흐름을 순차 실행한다.

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

온라인 에이전트의 실행은 아래 루프로 해석한다.

| 단계 | 의미 | 입력 | 출력 | 실패 처리 |
|------|------|------|------|-----------|
| Perceive | 질의와 현재 KG 상태 파악 | raw query, policy, KG 상태 | normalized query, risk context | query parse 실패 시 safe fallback |
| Plan | 질의 구조화 | normalized query, context bundle | `QueryPlan` | low-confidence plan이면 보수적 temporal/entity 해석 |
| Act | retrieval / reasoning / composition 실행 | `QueryPlan`, graph store | subgraph, evidence, chain, draft answer | KG miss 시 supplement, retrieval expansion |
| Observe | 중간 산출물 검증 | intermediate outputs | validation result | unsupported claim, temporal mismatch 탐지 |
| Reflect | 실패 원인 분석 | validation result, trace | repair decision | 어디서 틀렸는지 failure taxonomy로 태깅 |
| Iterate | 재시도 또는 종료 | repair decision | corrected answer or escalation | 반복 한도 초과 시 human review |

---

## 6. Constraint Layer

에이전트 계층에서는 아래 경계를 명확히 둔다.

| 규칙 | 설명 |
|------|------|
| Query Planner는 외부 API를 직접 호출하지 않는다 | planner는 질의 구조화에만 집중 |
| Graph Retriever는 허용된 edge type과 hop 범위 안에서만 탐색한다 | retrieval noise 폭증 방지 |
| Evidence Retriever는 PassageIndex와 graph evidence만 사용한다 | 임의의 근거 생성 금지 |
| Causal Reasoner는 evidence 없는 직접 인과를 단정하지 않는다 | overclaim 방지 |
| Answer Composer는 verification verdict를 무시할 수 없다 | unsupported claim이 감지되면 hedge 또는 abstain |
| Risk Controller는 최종 응답 전에 반드시 실행된다 | safety/compliance 게이트 역할 |

추가로 금융 도메인 특화 제약을 둔다.

- 투자 판단을 직접 권유하는 문장 금지
- "확실", "보장", "반드시" 같은 과도한 확신 표현 금지
- 최신성 확인이 불충분한 경우 "기준 시점"을 명시하거나 보수적 표현 사용
- entity resolution ambiguity가 큰 경우 확정 표현 대신 불확실성 경고 포함

---

## 7. Context Layer

에이전트가 항상 참고해야 하는 정보는 문서 설명이 아니라 구조화된 context asset으로 관리하는 것이 이상적이다.

권장 자산은 다음과 같다.

| 자산 | 역할 |
|------|------|
| ontology / schema snapshot | 이벤트 타입, entity 타입, edge 제약 |
| prompt bundle version | 질문 해석과 답변 템플릿 버전 관리 |
| eval slice definition | fact / temporal / causal / safety 질의 구분 |
| failure taxonomy | F1~F8 오류 분류 기준 |
| risk policy | 금지 문구, low-confidence 처리 규칙 |

이 문서에서는 위 자산을 설명 형태로 정의하고, 향후 하네스 구현 시 executable format으로 내리는 것을 전제한다.

---

## 8. Trace / Observability

하네스에서 반드시 수집해야 하는 trace는 아래와 같다.

### 8.1 Query-level trace

- raw user query
- normalized query
- planner output
- confidence / risk class

### 8.2 Retrieval trace

- seed node ids
- retrieved node / edge ids
- pruning 이전·이후 크기
- temporal filter 적용 결과
- missing gold seed 여부

### 8.3 Evidence trace

- selected evidence ids
- evidence ranking signal
- evidence text snippet
- contradiction evidence 포함 여부

### 8.4 Reasoning / Answer trace

- generated hypotheses
- accepted / rejected hypotheses
- checker verdict
- final answer
- cited evidence ids
- risk flags
- latency / token cost

이 trace가 있어야 "왜 틀렸는가"를 자동으로 읽을 수 있고, retrieval 문제인지 reasoning 문제인지 분리할 수 있다.

---

## 9. Verification Layer

온라인 계층의 기본 검증 포인트는 아래와 같다.

| 검증 항목 | 설명 |
|-----------|------|
| intent / entity / temporal consistency | planner가 질의 구조를 제대로 해석했는지 |
| subgraph relevance | 필요한 seed와 edge가 회수되었는지 |
| evidence sufficiency | 핵심 주장당 최소 근거 수 충족 여부 |
| contradiction inclusion | 반대 근거가 있을 때 함께 회수했는지 |
| temporal consistency | 이벤트 순서와 시점이 뒤집히지 않았는지 |
| unsupported claim rate | 근거 없는 주장 비율 |
| advice risk score | 투자 권유/과도한 확신 정도 |

정책적으로는 다음을 권장한다.

- 핵심 주장에 evidence가 없으면 answer를 강등하거나 abstain
- contradiction evidence가 있으면 summary에 병기
- causal 표현은 최소 2개 이상의 독립 근거가 없으면 hedge 표현으로 완화

---

## 10. Failure Case & Recovery

대표적인 실패 케이스와 복구 전략은 다음과 같다.

| 실패 케이스 | 원인 후보 | recovery |
|-------------|-----------|----------|
| KG Miss | seed 누락, subgraph recall 부족 | supplement 수집, retrieval expansion, 재시도 |
| 근거 부족 답변 | evidence retrieval 부족 | evidence 재검색, claim 축소, abstain |
| 시간축 오류 | temporal parse 실패, outdated evidence | 최신 문서 우선 재정렬, 기준 시점 명시 |
| 과장된 인과 | checker 미통과, evidence 불충분 | causal claim을 "가능성/해석"으로 낮춤 |
| 위험 표현 감지 | answer composer 문구 과장 | risk controller 후처리, 경고 추가 |

self-repair는 무한 반복하지 않는다. 동일 failure class로 재시도가 누적되면 human review 또는 safe failure로 종료한다.

---

## 11. Human-in-the-loop

다음 조건에서만 인간 개입을 요청한다.

- high-risk decision
- low-confidence output
- repeated system failure

구체적인 트리거 예시는 아래와 같다.

- entity ambiguity가 높고 핵심 answer에 직접 영향
- evidence sufficiency가 임계값 미달
- checker가 contradiction 또는 unsupported claim을 강하게 지적
- risk controller가 투자 권유성 문장을 반복적으로 검출

---

## 12. 관련 문서

- [02_query_planner.md](02_query_planner.md)
- [03_graph_retriever.md](03_graph_retriever.md)
- [04_evidence_retriever.md](04_evidence_retriever.md)
- [05_causal_reasoner.md](05_causal_reasoner.md)
- [06_risk_controller_and_answer_composer.md](06_risk_controller_and_answer_composer.md)
- [../06_pipeline_runtime/02_online_query_pipeline.md](../06_pipeline_runtime/02_online_query_pipeline.md)
