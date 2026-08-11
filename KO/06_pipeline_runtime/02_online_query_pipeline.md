# 02. 온라인 질의 파이프라인 (Online Query Pipeline)

## 1. 목적

사용자 질의가 입력될 때 실행되는 실시간 파이프라인이다. 질의 이해 → 검색 정책 결정 → 채널별 병렬 검색 → 근거 검증 → claim 생성/검증 → 답변 게이팅의 흐름을 처리하며, 재시도 예산 안에서만 제한적으로 복구를 시도한다. KG/corpus에 정보 자체가 없다고 판단되는 마지막 경우에만 실시간 보완 수집을 1회 실행한다.

하네스 엔지니어링 관점에서 온라인 파이프라인의 목표는 아래와 같다.

- 대부분의 질의를 **인간 개입 없이 안정적으로 처리**
- **근거 부족, 시간 오류, 위험한 표현**을 자동으로 감지
- 실패 시 **self-repair → safe fallback → human escalation** 순으로 대응

---

## 2. 실행 흐름

`FinancialKGPipeline.query(user_query, tenant_id, user_id, request_timestamp, assurance_mode) -> Dict`가 진입점이며, 실제 처리는 `AgentOrchestrator.process_request()`(`agent/orchestrator.py`)가 담당한다.

```text
Query Understanding Agent (LLM structured output)
        ↓ schema/entity/time validation (결정적)
Retrieval Policy Builder (결정적)
        ↓
memory / graph / hybrid(lexical+vector) / document-block worker 중
policy가 선택한 것만 병렬 실행
        ↓
Evidence Fusion(RRF) + Rerank
        ↓
Evidence Requirement Gate (근거 modality 사전 점검)
        ↓
Claim-first Generator (LLM, evidence ID 제약)
        ↓
Deterministic Claim Verifier (entailment/numeric/temporal/attribution/relation/locator)
        ↓
Answer Gate
  ├─ pass       → Answer Renderer → Risk/Harness post-check → 최종 답변
  ├─ repair     → Critic → Supervisor → 제한된 재검색/재계획 → (위 루프로 복귀)
  └─ abstain / clarification → 불확실성 표시 또는 재질문
        ↓
CitationLedger 기록 → PipelineHarness.evaluate_online_query() → StructuredAnswer
```

재시도는 "결과가 없다"는 사실만으로 수행하지 않는다. `TOOL_TIMEOUT`, `ENTITY_UNRESOLVED`, `RETRIEVAL_EMPTY`, `INSUFFICIENT_PRIMARY_EVIDENCE`, `NUMERIC_MISMATCH`처럼 구조화된 failure code와 `(worker, input_hash, failure_code)` 기준 retry budget을 함께 사용한다. 각 구성요소의 상세는 다음 문서를 따른다.

- [04_agent_system/01_agent_architecture.md](../04_agent_system/01_agent_architecture.md) — 전체 실행 루프와 컴포넌트 표
- [04_agent_system/02_query_understanding_and_routing.md](../04_agent_system/02_query_understanding_and_routing.md) — Query Understanding, Retrieval Policy
- [04_agent_system/03_retrieval_workers.md](../04_agent_system/03_retrieval_workers.md) — Graph/Hybrid/Document-block worker
- [04_agent_system/04_evidence_and_claims.md](../04_agent_system/04_evidence_and_claims.md) — Evidence Requirement Gate, Claim-first Generator
- [04_agent_system/05_verification_and_answer_gate.md](../04_agent_system/05_verification_and_answer_gate.md) — Claim Verifier, Answer Gate
- [04_agent_system/06_recovery_memory_and_harness.md](../04_agent_system/06_recovery_memory_and_harness.md) — Critic/Supervisor, 사용자 메모리, 위험 관리

---

## 3. `FinancialKGPipeline.query()`의 역할

```python
def query(self, user_query, *, tenant_id="default", user_id="anonymous",
          request_timestamp=None, assurance_mode="high_assurance") -> Dict:
    agent_run = self.agent_orchestrator.process_query_with_trace(
        user_query, tenant_id=tenant_id, user_id=user_id,
        request_timestamp=request_timestamp, assurance_mode=assurance_mode,
    )
    online_run = self.harness.evaluate_online_query(user_query, agent_run, attempt=0, recovery_action="primary")
    answer = online_run["answer"]

    if (
        answer.status == "abstained"
        and retryable_retrieval_failure   # RETRIEVAL_EMPTY / INSUFFICIENT_PRIMARY_EVIDENCE 이면서 retryable
        and self.config.harness.enable_online_supplement
        and online_sources_configured
    ):
        await self._online_supplement(user_query)   # 질의 키워드로 소량 실시간 수집 -> 기존 KG에 병합
        self.step4_init_agents()                     # entity_dict/agent 재초기화
        agent_run = self.agent_orchestrator.process_query_with_trace(...)  # 2차 시도
        online_run = self.harness.evaluate_online_query(user_query, agent_run, attempt=1, recovery_action="online_supplement")

    payload = answer.model_dump(mode="json")
    payload["harness"] = {
        "run_id": online_run["run_id"], "verification": online_run["verification"],
        "failure_cases": online_run["failure_cases"], "gate_status": online_run["gate_status"], ...
    }
    return payload
```

핵심은 `_online_supplement`가 **모든** retrieval 실패에 대응하지 않는다는 점이다. `AgentOrchestrator` 내부의 Critic/Supervisor 루프가 이미 허용된 검색 채널·기간·동의어 확장을 다 시도한 뒤에도 답변이 `abstained`이고, 원인이 "KG/corpus에 관련 정보 자체가 없음"으로 좁혀졌을 때만 외부 실시간 수집을 고려한다. 모든 retrieval 실패를 외부 수집으로 해결하려 하면 지연·비용·재현성 문제가 커지기 때문이다.

### 3.1 실시간 보완 수집 (`_online_supplement`)

```text
1. 질의에서 키워드 추출 (2자 이상 한글/영문 토큰, 최대 3개)
2. 네이버 뉴스 소량 수집(최대 20건) + DART 공시 수집
3. 정규화 -> canonicalization -> preprocessing -> GraphPayload 빌드
4. harness.validate_graph_payload() 통과 시에만 기존 graph_store에 병합(replace=False)
5. 실패하면 병합을 중단하고 경고만 남김 (부분 오염된 KG를 만들지 않음)
```

---

## 4. Worker 계약

각 worker는 `WorkerResult(worker, status, output_ids, failure, metadata)`를 반환한다. `status`는 `SUCCESS`/`PARTIAL`/`FAILED`/`SKIPPED` 중 하나이며, 빈 목록을 성공으로 취급하지 않는다.

| worker | 입력 | 출력 | 성공 조건 | 대표 실패 코드 |
|---|---|---|---|---|
| `graph_retrieval` | `QuerySpec`, `RetrievalPolicy` | `GraphWorkerOutput` (evidence, paths, subgraph) | seed와 admissible evidence를 모두 확보 | `ENTITY_UNRESOLVED`, `RETRIEVAL_EMPTY`, `INSUFFICIENT_PRIMARY_EVIDENCE` |
| `hybrid_retrieval` | `QuerySpec`, `RetrievalPolicy` | `HybridWorkerOutput` (evidence, hits) | lexical/vector 융합 결과 확보 | `RETRIEVAL_EMPTY`, `RETRIEVAL_DEGRADED`, `MODEL_FALLBACK` |
| `document_block_retrieval` | 동일(표/그림 전용) | 동일 | 표/그림 evidence 확보 | 동일 |
| memory selection | `QuerySpec` | `MemorySelection` | (해당 시) 관련 메모리 선택 | `memory_worker_failed:*` |

---

## 5. Constraint Layer

| 규칙 | 설명 |
|------|------|
| 최신성 단정 금지 | `as_of` 이후 발행 evidence는 admissible하지 않으며, "최근/현재"를 근거 없이 확정 표현하지 않음 |
| retrieval/근거 검증 없이 claim 생성 금지 | Evidence Requirement Gate가 `pass`여야만 Claim Generator 호출 |
| speculative statement 제한 | 인과 표현은 evidence의 `causal=True` edge 또는 명시적 인과 마커가 있을 때만 허용 |
| high-risk financial advice 금지 | 매수/매도 추천, 수익 보장, 확정적 전망 금지 — claim 생성 프롬프트 + harness advice-risk 검사 이중 적용 |
| retry budget 제한 | self-repair는 `RetrievalPolicy.retry_budget`과 `Supervisor.max_same_failure_retries` 안에서만 수행 |

---

## 6. Verification Layer 요약

claim-level 검증(coverage/entailment/numeric/temporal/attribution)의 상세는 [04_agent_system/05_verification_and_answer_gate.md](../04_agent_system/05_verification_and_answer_gate.md)를 따른다. 이 문서에서는 online 실행 관점의 요약만 정리한다.

| 계층 | 검증 항목 |
|---|---|
| Planner/Policy | intent/entity/temporal 정확도, evidence_needs 판정 정확도, 채널 선택 정확도 |
| Evidence | evidence recall@k/precision@k, citation coverage, contradiction 포함 여부, locator 유효성 |
| Claim/Answer | numeric/temporal/attribution 정확도, unsupported claim rate, causal overclaim rate, advice risk score |

권장 운영 규칙:

- 핵심 주장마다 최소 1개 이상의 직접 evidence 필요 (Evidence Requirement Gate + Answer Gate)
- contradiction evidence가 있으면 임의로 한쪽을 택하지 않고 병기(`conflicts` 필드) 또는 abstain
- causal claim은 graph edge의 `causal=True`와 원문 근거가 함께 있을 때만 확정적으로 표현
- low-confidence answer는 명시적으로 `confidence`/`risk_warnings`를 부착

---

## 7. Feedback Loop Layer

### 7.1 Recovery 우선순위

Critic/Supervisor의 판정 순서와 action 매핑은 [04_agent_system/06_recovery_memory_and_harness.md §1](../04_agent_system/06_recovery_memory_and_harness.md)을 따른다. 요약하면:

```text
1. entity ambiguous/unresolved (worker 실행 전) → clarification
2. 그래프 관련 실패 → graph 재시도
3. 수치/표/시간/귀속 관련 실패 → document-block 재시도
4. 원문 발언/citation 부족 → hybrid 재시도(동의어 확장)
5. 그 외 claim 실패 → 해당 claim 제거 후 재검증
6. 상충 evidence → 임의 선택 없이 abstain
7. retry budget 소진 또는 질문 모호 → abstain / clarification / (근거 자체가 없으면) 실시간 보완 수집 후 1회 재시도
```

### 7.2 Failure Taxonomy 연결

온라인 실패는 F1(엔티티 혼동), F2(시간축 오류), F3(숫자 오류), F4(귀속 오류), F5(근거 누락), F6(추론 과장), F7(안전성 오류), F8(과잉 방어) 중 하나 이상으로 태깅된다. 이 분류가 있어야 retrieval 병목인지 reasoning 병목인지 분리할 수 있다.

---

## 8. Trace / Observability

`CitationLedger`(session 단위 불변 기록)와 `PipelineHarness`가 남기는 trace 파일의 상세는 [04_agent_system/01_agent_architecture.md §10](../04_agent_system/01_agent_architecture.md)에 정리되어 있다. 온라인 실행 1회마다 아래 파일이 `online_registry_dir`에 저장된다.

- `query_trace.json`, `retrieval_trace.json`, `evidence_trace.json`, `reasoning_trace.json`, `answer_trace.json`
- `verification.json`, `orchestration_trace.json`(query_spec/policy/worker_results/claims/verdicts/ledger 요약), `run_record.json`
- 실패가 있으면 `failure_cases.json`

이 trace가 없으면 "답변이 왜 틀렸는가"보다 "답변이 틀렸다"만 알게 된다.

---

## 9. Human-in-the-loop 설계

인간 개입은 아래 상황에서만 발생한다.

| 조건 | 예시 |
|------|------|
| high-risk decision | 투자 조언성 질의, 규제/법적 해석, 민감한 시장 전망 |
| low-confidence output | entity ambiguity, evidence insufficiency, temporal uncertainty |
| system failure | self-repair 반복 실패, 실시간 보완 수집 후에도 근거 부족 지속 |

`answer.human_review_required = True`이면 `review_ticket`(run_id, risk_class, failure_codes, trace_paths, recommended_action)이 답변에 첨부된다.

---

## 10. LLM 사용 위치

| 지점 | 사용 여부 | 비고 |
|------|-----------|------------------|
| Query Understanding Agent | 사용 | QuerySpecDraft 생성, 실패 시 1회 repair 후 결정적 fallback |
| Claim-first Generator | 사용 | evidence ID로 제약된 atomic claim, 실패 시 1회 repair 후 결정적 fallback(원문 추출) |
| Retrieval Policy Builder, Deterministic Claim Verifier, Answer Gate, Critic, Supervisor | 사용 안 함 | 전부 코드/규칙 기반 |
| Retrieval(BM25/BGE-M3/graph traversal/RRF/rerank) | 사용 안 함(검색 전용 모델) | 모델 로드 실패 시 명시적 결정적 fallback으로 표시 |

핵심 원칙은 다음과 같다.

- retrieval과 evidence 없이 LLM이 답을 주도하지 않게 한다 (Evidence Requirement Gate가 선행)
- LLM 출력은 항상 verification layer의 검증을 거친다
- 안전성 문제는 harness의 사후 점검이 최종적으로 다시 확인한다

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

- `factual_accuracy`, `evidence_grounding_score`, `temporal_accuracy`
- `unsupported_claim_rate`, `citation_coverage`
- `latency_p95`, `token_cost_per_query`
- `compliance_pass_rate`(advice-risk 미검출 비율)

hard gate 예: unsupported claim 폭증, advice risk score 악화, temporal consistency 급락.
soft gate 예: latency 증가, cost 증가, conciseness/readability 소폭 하락.

---

## 12. 설계 의사결정 근거

**왜 self-repair를 무한 반복하지 않는가?**
실시간 보완 수집이 항상 관련 정보를 가져온다는 보장이 없다. 무한 재시도는 응답 지연과 비용을 폭증시킨다. 일정 횟수 이후에는 safe failure 또는 human review가 더 바람직하다.

**왜 contradiction evidence를 함께 봐야 하는가?**
금융 영역에서는 동일 사건에 대해 상반된 해석이 흔하다. 찬성 근거만 보는 시스템은 그럴듯하지만 위험한 답변을 만들기 쉽다.

**왜 online trace가 중요한가?**
retrieval 문제인지, reasoning 문제인지, answer composition 문제인지 분리할 수 있어야 개선 속도가 빨라진다. trace 없는 시스템은 회귀를 감지해도 원인을 특정하기 어렵다.

**왜 실시간 보완 수집을 마지막 수단으로 두는가?**
Critic/Supervisor가 이미 허용된 검색 채널·기간·표현을 다 시도했는데도 근거가 없다면, 문제는 retrieval 전략이 아니라 KG/corpus 자체의 공백일 가능성이 높다. 이 경우에만 외부 수집 비용을 지불하는 것이 지연과 재현성을 지키면서 커버리지를 넓히는 합리적인 순서다.
