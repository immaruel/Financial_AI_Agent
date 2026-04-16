# 02. 온라인 질의 파이프라인 (Online Query Pipeline)

## 1. 목적

사용자 질의가 입력될 때 실행되는 실시간 파이프라인이다. KG 탐색 → 근거 회수 → 답변 생성의 흐름을 처리하며, KG에 관련 정보가 없는 경우 실시간 보완 수집을 실행하여 재시도한다.

하네스 엔지니어링 관점에서 온라인 파이프라인의 목표는 아래와 같다.

- 대부분의 질의를 **인간 개입 없이 안정적으로 처리**
- **근거 부족, 시간 오류, 위험한 표현**을 자동으로 감지
- 실패 시 **self-repair → safe fallback → human escalation** 순으로 대응

---

## 2. Harness-aware 실행 흐름

`FinancialKGPipeline.query(user_query: str) -> Dict`

```text
사용자 질의 입력
        │
        ▼
[Perceive]
  query normalize
  risk context 확인
  agent 준비 상태 확인

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
  evidence sufficiency, temporal consistency,
  unsupported claim, advice risk 점검

        │
        ├─ 통과 -> 최종 응답 반환
        │
        └─ 실패
             │
             ▼
        [Reflect]
          failure taxonomy 분류
          repair action 선택

             │
             ▼
        [Iterate]
          - KG Miss면 supplement
          - retrieval expansion
          - certainty downgrade
          - human escalation
```

---

## 3. 현재 구현의 실행 흐름

### 3.1 기본 질의 처리

```python
if not self.agent_orchestrator:
    self.step4_init_agents()

answer = self.agent_orchestrator.process_query(user_query)
```

`process_query()` 내부에서는 아래 순서로 실행된다.

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

### 3.2 KG Miss 감지 및 실시간 보완

현재 구현의 기본 recovery는 KG Miss 재시도다.

```python
if not answer.timeline and not answer.related_companies:
    asyncio.get_event_loop().run_until_complete(
        self._online_supplement(user_query)
    )
    self.step4_init_agents()
    answer = self.agent_orchestrator.process_query(user_query)
```

이 전략은 "질의에 필요한 정보가 그래프에 아예 없는 경우"에 대응한다.

---

## 4. 단계별 입출력, 성공 조건, 실패 조건

| 단계 | 입력 | 출력 | 성공 조건 | 실패 조건 |
|------|------|------|-----------|-----------|
| Query Planner | raw query | `QueryPlan` | intent, entity, temporal scope가 적절히 구조화 | intent 오분류, entity/time 누락 |
| Graph Retriever | `QueryPlan`, KG | `SubGraphResult` | 필요한 seed/subgraph를 충분히 회수 | 관련성 낮은 노드 과다, gold seed 누락 |
| Evidence Retriever | subgraph, PassageIndex | `List[EvidenceResult]` | 핵심 주장에 대응하는 원문 확보 | evidence 부족, contradiction 미포함 |
| Causal Reasoner | subgraph + evidence | `CausalChain` | 시계열/인과 정합성 유지 | 시간 순서 역전, 과장된 인과 |
| Hypothesis Checker | chain + evidence | verification verdict | unsupported claim / contradiction 탐지 | 검증 실패 누락 |
| Answer Composer | plan + evidence + chain + verdict | draft answer | citation 정렬, 사실/해석 구분 | 근거 없는 요약, 숫자 오류 |
| Risk Controller | draft answer | final answer | 위험 문구 제어, 경고 포함 | 투자 권유 노출, 과도한 회피 |

---

## 5. Constraint Layer

온라인 에이전트 계층에는 아래 제약을 둔다.

| 규칙 | 설명 |
|------|------|
| 최신성 단정 금지 | 최신 정보 보장이 없을 때 "최근/현재"를 확정 표현으로 쓰지 않음 |
| retrieval 없이 compose 금지 | evidence가 없는 상태에서 답변 초안 작성 금지 |
| speculative statement 제한 | 전망·예측은 근거와 함께 hedge 표현으로만 허용 |
| high-risk financial advice 금지 | 매수/매도 추천, 수익 보장, 확정적 전망 금지 |
| retry budget 제한 | self-repair는 정해진 횟수 안에서만 수행 |

이 제약은 금융 도메인에서 특히 중요하다. "그럴듯한 답변"이 아니라 "근거와 불확실성이 관리된 답변"을 목표로 하기 때문이다.

---

## 6. Verification Layer

온라인 계층의 기본 검증은 아래 항목을 포함한다.

### 6.1 Planner / Retrieval 검증

- `intent classification accuracy`
- `entity phrase extraction accuracy`
- `temporal constraint extraction accuracy`
- `seed precision / recall`
- `subgraph recall@k`
- `irrelevant node ratio`

### 6.2 Evidence 검증

- `evidence recall@k`
- `evidence precision@k`
- `citation coverage`
- `contradiction recall`

### 6.3 Reasoning / Answer 검증

- `temporal consistency`
- `unsupported claim rate`
- `causal overclaim rate`
- `numeric accuracy`
- `citation alignment`
- `advice risk score`

권장 운영 규칙:

- 핵심 주장마다 최소 1개 이상의 직접 evidence 필요
- contradiction evidence가 존재하면 answer에 병기
- causal claim은 증거가 약하면 "가능성", "시장 해석" 수준으로 강등
- low-confidence answer는 명시적으로 confidence / warning 부착

---

## 7. Feedback Loop Layer

온라인 계층의 self-repair는 아래 순서로 동작하는 것이 좋다.

### 7.1 Recovery 우선순위

1. `KG Miss`면 supplement 수집
2. seed가 애매하면 retrieval expansion 또는 alias 재탐색
3. evidence 부족이면 claim 수를 줄이고 answer를 보수적으로 재구성
4. temporal mismatch면 최신 문서 우선 정렬 후 재평가
5. risk fail이면 표현을 downgrade
6. 반복 실패면 human escalation

### 7.2 Failure Taxonomy 연결

온라인 실패는 아래 taxonomy 중 하나 이상으로 태깅한다.

- F1 엔티티 혼동
- F2 시간축 오류
- F3 숫자 오류
- F5 근거 누락
- F6 추론 과장
- F7 안전성 오류
- F8 과잉 방어

이 분류가 있어야 retrieval 병목인지 reasoning 병목인지 분리할 수 있다.

---

## 8. Trace / Observability

온라인 하네스는 최소 아래 trace를 저장해야 한다.

### 8.1 Query trace

- raw query
- normalized query
- planner output
- temporal constraints
- target entities

### 8.2 Retrieval trace

- seed nodes
- retrieved nodes / edges
- pruning 결과
- retrieval score 또는 rank signal

### 8.3 Evidence trace

- selected evidence ids
- evidence snippet
- contradiction evidence 포함 여부

### 8.4 Answer trace

- checker verdict
- final answer
- cited evidence ids
- risk flags
- latency
- token cost

이 trace가 없으면 "답변이 왜 틀렸는가"보다 "답변이 틀렸다"만 알게 된다.

---

## 9. Human-in-the-loop 설계

인간 개입은 아래 상황에서만 발생한다.

| 조건 | 예시 |
|------|------|
| high-risk decision | 투자 조언성 질의, 규제/법적 해석, 민감한 시장 전망 |
| low-confidence output | entity ambiguity, evidence insufficiency, temporal uncertainty |
| system failure | self-repair 반복 실패, supplement 후에도 KG miss 지속 |

권장 escalation 결과:

- `safe_answer`: 정보 부족을 명시하고 제한 답변 반환
- `review_ticket`: 사람이 확인할 수 있도록 trace와 failure class 전달

---

## 10. LLM 사용 위치

현재 구현에서 온라인 파이프라인의 핵심 LLM 호출 지점은 `AnswerComposerAgent`다.

| 지점 | 현재 구현 | 하네스 확장 관점 |
|------|-----------|------------------|
| AnswerComposerAgent | 상시 사용 | grounded answer 생성 |
| HypothesisCheckerAgent | rule/LLM 혼합 가능 | unsupported claim, contradiction 탐지 |
| EntityTypeClassifier fallback | 현재 미적용 또는 선택적 | 향후 low-confidence typing 보완용 |

핵심 원칙은 다음과 같다.

- retrieval과 evidence 없이 LLM이 답을 주도하지 않게 한다
- LLM 출력은 항상 verification layer의 검증을 거친다
- 안전성 문제는 Risk Controller가 최종적으로 제어한다

---

## 11. CI/CD Gate와 운영 메트릭

온라인 파이프라인의 배포 전 gate는 다음 메트릭을 우선 본다.

- Accuracy
- Faithfulness
- Consistency
- Latency
- Cost
- Safety / Compliance

구체 메트릭 예:

- `factual_accuracy`
- `evidence_grounding_score`
- `temporal_accuracy`
- `unsupported_claim_rate`
- `latency_p95`
- `token_cost_per_query`
- `compliance_pass_rate`

hard gate 예:

- unsupported claim 폭증
- advice risk score 악화
- temporal consistency 급락

soft gate 예:

- latency 증가
- cost 증가
- conciseness/readability 소폭 하락

---

## 12. 설계 의사결정 근거

**왜 self-repair를 무한 반복하지 않는가?**
실시간 보완 수집이 항상 관련 정보를 가져온다는 보장이 없다. 무한 재시도는 응답 지연과 비용을 폭증시킨다. 일정 횟수 이후에는 safe failure 또는 human review가 더 바람직하다.

**왜 contradiction evidence를 함께 봐야 하는가?**
금융 영역에서는 동일 사건에 대해 상반된 해석이 흔하다. 찬성 근거만 보는 시스템은 그럴듯하지만 위험한 답변을 만들기 쉽다.

**왜 online trace가 중요한가?**
retrieval 문제인지, reasoning 문제인지, answer composition 문제인지 분리할 수 있어야 개선 속도가 빨라진다. trace 없는 시스템은 회귀를 감지해도 원인을 특정하기 어렵다.
