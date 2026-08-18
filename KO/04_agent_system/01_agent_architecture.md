# 01. 에이전트 시스템 아키텍처 (Agent Architecture)

## 1. 목적

사용자의 자연어 질의를 받아 질문이 요구하는 근거 유형에 따라 검색 채널을 선택·병렬 실행하고, claim 단위로 검증한 뒤 실패를 진단·복구하는 검증 가능한 멀티 에이전트 오케스트레이션을 정의한다.

이 문서는 단순히 "어떤 에이전트가 있는가"를 설명하는 데서 끝나지 않는다. 하네스 엔지니어링 관점에서 다음을 함께 정의한다.

- 각 에이전트/worker의 입력과 출력 계약
- 성공 조건과 실패 조건
- 실행 루프에서의 검증 포인트
- trace/ledger 수집 규격
- self-repair와 human escalation 기준

---

## 2. "에이전트"의 정의와 설계 원칙

`AgentOrchestrator`(`agent/orchestrator.py`)는 여러 클래스를 항상 같은 순서로 호출하는 고정 파이프라인이 아니다. 아래 5가지 조건을 모두 만족해야 멀티 에이전트 오케스트레이션이라고 부른다.

1. **Planner 결과에 따라 worker 집합이 달라진다** — `RetrievalPolicy.channels`에 없는 worker는 아예 실행하지 않는다.
2. **독립 worker와 verifier는 병렬 실행한다** — memory/graph/hybrid/document-block worker는 `ThreadPoolExecutor`로 동시 실행되고, claim verifier의 4개 검증 축(entailment/numeric/temporal/attribution)도 pair 단위로 함께 계산된다.
3. **worker별 tool 권한과 결과 스키마가 다르다** — graph worker는 그래프 traversal과 confidence 임계값만, hybrid worker는 BM25/dense 검색만 수행하며 서로의 자원에 접근하지 않는다.
4. **Supervisor가 실패 상태를 바탕으로 재시도·대체 경로·중단을 선택한다** — `CriticAgent.diagnose()` → `Supervisor.authorize()`가 이 결정을 담당한다.
5. **모든 의사결정과 tool call을 trace로 재현할 수 있다** — `CitationLedger`가 session 단위로 불변 기록을 남긴다.

"agent"는 단지 LLM 호출을 뜻하지 않는다. 독립 입력/출력 계약, 제한된 tool 권한, 성공·실패 상태, 동적 라우팅 중 적어도 하나 이상의 실행 책임을 가진 역할이다. 반대로 BM25/RRF/그래프 탐색처럼 재현 가능한 search는 결정적 worker로 유지한다.

---

## 3. 논리 컴포넌트

| 컴포넌트 | 클래스/모듈 | 역할 | LLM 사용 |
|----------|--------|------|---|
| Query Understanding Agent | `QueryUnderstandingAgent` (`agent/query_understanding.py`) | 자연어 질의 → `QuerySpecDraft` → 결정적 검증을 거친 `QuerySpec` | 사용 |
| Retrieval Policy Builder | `RetrievalPolicyBuilder` (`agent/routing.py`) | `QuerySpec` → `RetrievalPolicy` (channel/budget/retry) | 사용 안 함 |
| Graph Retrieval Worker | `GraphRetrievalWorker` (`retrieval/graph.py`) | seed 탐색 → subgraph → path → EvidenceBlock 확장 | 사용 안 함 |
| Hybrid / Document-block Retrieval Worker | `HybridRetrievalWorker` (`retrieval/hybrid.py`) | BM25 + BGE-M3 lexical/vector 검색, `document_blocks_only=True`이면 표/그림 전용 | 사용 안 함 |
| Evidence Fusion & Rerank | `fuse_ranked_evidence` + `Reranker` (`retrieval/hybrid.py`) | 채널별 rank를 RRF로 융합하고 cross-encoder로 재정렬 | 사용 안 함(cross-encoder는 검색 전용 모델) |
| Memory Lifecycle Agent | `MemoryLifecycleAgent` (`agent/memory_extraction.py`) | 명시적 사용자 선호/피드백 → 구조화 후보. 정책·확인 전에 저장 불가 | 후보 추출에만 사용 |
| User Memory Store | `UserMemoryStore` (`agent/memory.py`) | tenant/user 범위의 개인화 메모리를 결정적 규칙으로 선택 | 사용 안 함 |
| Context Builder | `ContextBuilder` (`agent/context_builder.py`) | QuerySpec/evidence/graph path/memory를 evidence-ID allowlist 컨텍스트로 조립 | 사용 안 함 |
| Evidence Requirement Gate | `EvidenceRequirementGate` (`agent/requirements.py`) | 생성 이전에 `required` 근거 modality 충족 여부를 사전 차단 | 사용 안 함 |
| Claim-first Generator | `ClaimFirstGenerator` (`agent/generation.py`) | context → evidence ID로 제약된 atomic claim | 사용 |
| Deterministic Claim Verifier | `DeterministicClaimVerifier` (`agent/verification.py`) | claim-evidence pair별 entailment/numeric/temporal/attribution/relation/locator 검증 | 사용 안 함 |
| Answer Gate | `AnswerGate` (`agent/verification.py`) | claim verdict → pass/repair/abstain | 사용 안 함 |
| Critic | `CriticAgent` (`agent/supervisor.py`) | gate reason code + worker failure → `RecoveryDecision` | 사용 안 함 |
| Supervisor | `Supervisor` (`agent/supervisor.py`) | 허용된 recovery action만 승인, 동일 실패 재시도 횟수 제한 | 사용 안 함 |

`AgentOrchestrator`는 이 컴포넌트들을 조립하고, 위 표에 없는 로직(answer 렌더링, ledger 기록, trace 계산)을 직접 수행한다.

---

## 4. 전체 실행 흐름

```text
사용자 질의 + tenant_id + user_id + session_id + request_timestamp
        │
        ▼
[1] QueryUnderstandingAgent.understand()
        │  QuerySpec (validation_status: valid / entity_ambiguous / planner_fallback)
        ▼
[2] RetrievalPolicyBuilder.build()
        │  RetrievalPolicy (channels, source_filters, date_filter, evidence_budget, retry_budget)
        ▼
[3] 병렬 실행 (ThreadPoolExecutor)
        │  ├─ UserMemoryStore.select()            (memory_mode != off)
        │  ├─ GraphRetrievalWorker.run()           ("graph" in channels)
        │  ├─ HybridRetrievalWorker.run()          ("lexical"/"vector" in channels)
        │  └─ HybridRetrievalWorker.run(document_blocks_only=True)  ("document_block" in channels)
        ▼
[4] fuse_ranked_evidence() (RRF) → Reranker.rerank() → prioritize_relative_order()
        │  List[EvidenceBlock]
        ▼
[5] EvidenceRequirementGate.evaluate()
        │  pass 아니면 바로 [8]로 (생성 없이 재시도/중단)
        ▼
[6] ContextBuilder.build() → ClaimFirstGenerator.generate()
        │  List[AtomicClaim]
        ▼
[7] VerificationPipeline.verify_and_gate()
        │  = DeterministicClaimVerifier.verify() + AnswerGate.evaluate()
        │  AnswerGateDecision (pass / repair / abstain / clarification)
        ▼
[8] gate.decision == pass?
        ├─ 예 → _render_answer() → StructuredAnswer
        └─ 아니오 → CriticAgent.diagnose() → Supervisor.authorize()
                      │  RecoveryDecision.next_actions
                      ▼
                _run_recovery_worker() (graph 재시도 / document-block 재시도 /
                      hybrid 재시도+term 확장 / claim 제거) → [4]로 복귀
                동일 (worker, input_hash, failure_code) 재시도 한도 초과 시 abstain
        ▼
CitationLedger 기록 → StructuredAnswer 반환
```

메모리 **저장** 흐름은 위 온라인 질의 흐름과 별개다. `propose_user_memory()`가 LLM 후보를 만들고, `confirm_user_memory()` 또는 명시적으로 활성화한 auto-commit 정책이 `UserMemoryStore` write를 호출한다. 따라서 `process_request()`는 저장 권한이 없다.

`agent/orchestrator.py`의 `process_request()`가 이 전체 루프를 실행한다.

```python
class AgentOrchestrator:
    def __init__(self, config, graph_store, llm_client=None, entity_dict=None, memory_store=None):
        self.query_understanding = QueryUnderstandingAgent(llm_client, entity_dict or {})
        self.policy_builder = RetrievalPolicyBuilder(config.retrieval, config.supervisor)
        self.memory_store = memory_store or UserMemoryStore(config.memory, ...)
        self.memory_lifecycle = MemoryLifecycleAgent(config.memory, llm_client)
        self.context_builder = ContextBuilder(config.context)
        self.claim_generator = ClaimFirstGenerator(llm_client, config.audit)
        self.requirement_gate = EvidenceRequirementGate()
        self.verification = VerificationPipeline(config.verification)
        self.critic = CriticAgent()
        self.supervisor = Supervisor(config.supervisor)

    def process_request(self, request: QueryRequest) -> AgentRunResult:
        spec = self.query_understanding.understand(request)
        policy = self.policy_builder.build(spec, request.assurance_mode)
        memory_selection, worker_outputs, tool_calls = self._run_initial_workers(spec, policy, ...)
        evidence, _ = self._fuse_and_rerank(spec.original_query, [...], policy, catalog)
        while True:
            gate = self.requirement_gate.evaluate(spec, evidence, graph_output.paths, worker_results)
            if gate.decision == "pass":
                context = self.context_builder.build(spec, policy, evidence, ...)
                claims, _ = self.claim_generator.generate(spec, context, evidence)
                verdicts, gate = self.verification.verify_and_gate(claims, evidence, as_of=spec.as_of, query_spec=spec)
                if gate.decision == "pass":
                    break
            decision = self.supervisor.authorize(self.critic.diagnose(gate, worker_results, retries_remaining))
            if decision.decision in {"abstain", "clarification"}:
                break
            # run_graph_retrieval / run_document_block_retrieval / run_hybrid_text_retrieval / remove_claim
            output, trace = self._run_recovery_worker(decision.next_actions[0], spec, policy, catalog, graph_worker)
            ...
        return AgentRunResult(answer=self._render_answer(...), ledger=ledger, ...)
```

---

## 5. Perceive → Plan → Act → Observe → Reflect → Iterate 매핑

| 단계 | 실제 구현 | 입력 | 출력 | 실패 처리 |
|------|------|------|------|-----------|
| Perceive | `QueryRequest` 생성, entity_ambiguous/graph 미해소 preflight 검사 | raw query, tenant/user, request_timestamp | `QueryRequest` | 미해소 필수 엔티티는 worker 실행 전에 `clarification`으로 즉시 종료 |
| Plan | `QueryUnderstandingAgent` + `RetrievalPolicyBuilder` | normalized query | `QuerySpec`, `RetrievalPolicy` | 스키마 검증 실패 시 1회 repair, 재실패 시 결정적 fallback draft |
| Act | worker 병렬 실행 + fusion/rerank + claim 생성 | `QuerySpec`, `RetrievalPolicy` | `WorkerResult`, `EvidenceBlock`, `AtomicClaim` | worker별 실패 코드(`TOOL_TIMEOUT`, `RETRIEVAL_EMPTY`, `ENTITY_UNRESOLVED` 등)를 결과 계약에 기록 |
| Observe | `EvidenceRequirementGate` + `VerificationPipeline` | evidence, claims | `AnswerGateDecision`, `ClaimVerdict` | coverage/numeric/temporal/attribution 불일치를 reason_codes로 구조화 |
| Reflect | `CriticAgent.diagnose()` | gate, worker_results, retries_remaining | `RecoveryDecision` | 재시도 가능 여부와 대체 채널을 코드 규칙으로 결정 |
| Iterate | `Supervisor.authorize()` + `_run_recovery_worker()` | recovery decision | corrected answer / abstain / clarification | 동일 `(worker, input_hash, failure_code)` 재시도 한도 초과 시 안전 종료 |

---

## 6. Constraint Layer

에이전트 계층에서는 아래 경계를 명확히 둔다.

| 규칙 | 구현 위치 |
|------|------|
| Query Understanding Agent는 tool 이름이나 canonical entity ID를 직접 만들지 않는다 | `QueryUnderstandingAgent`가 surface만 추출, `DeterministicEntityResolver`가 확정 |
| `evidence_needs`는 boolean이 아니라 `required`/`preferred`/`not_needed`이며 질의 키워드와 충돌하면 코드가 보정한다 | `QuerySpecValidator._validated_needs()` |
| Graph Retrieval Worker는 허용된 edge type과 hop 범위 안에서만 탐색한다 | `GraphRetrievalWorker._edge_types()`, `min_edge_confidence` |
| Retrieval Policy는 코드로만 결정하며 LLM이 채널을 직접 선택하지 않는다 | `RetrievalPolicyBuilder.build()` |
| Claim Generator는 context에 없는 evidence ID를 인용할 수 없다 | `ClaimFirstGenerator.generate()`의 allowlist 검증 + repair |
| 근거 없는 인과 단정 금지 — `PRECEDES`/`POSSIBLY_RELATED_AFTER`를 인과로 승격하지 않는다 | `CLAIM_SYSTEM_PROMPT` 규칙 + verifier의 `_relation_semantics()` |
| Answer Gate를 통과하지 못한 claim은 최종 답변에 포함되지 않는다 | `_render_answer()`가 `gate.accepted_claim_ids`만 사용 |
| retry budget은 정책과 Supervisor가 통제하며 무한 재시도를 허용하지 않는다 | `RetrievalPolicy.retry_budget`, `Supervisor.register_failure()` |

추가로 금융 도메인 특화 제약을 둔다.

- 투자 판단을 직접 권유하는 문장 금지, "확실", "보장", "반드시" 같은 과도한 확신 표현 억제
- 최신성 확인이 불충분한 경우 `as_of`를 명시하고 보수적 표현 사용
- entity resolution ambiguity가 큰 경우 확정 표현 대신 `clarification`으로 중단

---

## 7. Context Layer

에이전트가 항상 참고해야 하는 정보는 구조화된 context asset으로 관리한다.

| 자산 | 역할 | 구현 |
|------|------|------|
| ontology / schema snapshot | 이벤트 타입, entity 타입, edge 제약 | `ontology/`, `utils/schemas.py` |
| prompt bundle version | 질문 해석과 claim 생성 프롬프트 버전 관리 | `AuditConfig.query_prompt_version`, `claim_prompt_version` |
| retrieval/index snapshot | 재현 가능한 검색을 위한 evidence corpus 버전 | `EvidenceCatalog.snapshot_id` |
| failure taxonomy | F1~F8 오류 분류 기준 | [00_overview.md §9](../00_overview.md) |
| risk policy | 금지 문구, low-confidence 처리 규칙 | `harness/runtime.py`의 advice-risk 검사, `_render_answer()`의 고정 warning |

---

## 8. Verification Layer

| 검증 항목 | 구현 위치 |
|-----------|------|
| QuerySpec schema / entity / time 유효성 | `QuerySpecValidator` |
| Evidence Requirement Gate (생성 이전) | `EvidenceRequirementGate.evaluate()` |
| claim-evidence entailment | `DeterministicClaimVerifier.verify_pair()` (`entailment`) |
| numeric/unit/currency/기간 일치 | `DeterministicClaimVerifier._verify_numeric()` |
| 발화/서술 시점(`as_of`) 일치 | `DeterministicClaimVerifier._verify_temporal()` |
| 발언자/기업/문서 귀속 | `DeterministicClaimVerifier._verify_attribution()` |
| 관계 방향/인과 과장 방지 | `_relation_semantics()` |
| citation coverage 임계값, critical claim 차단 | `AnswerGate.evaluate()` |

핵심 원칙: 상충하는 지지·반박 evidence가 모두 유효하면 claim은 `conflict` 상태가 되어 최종 답변에서 임의로 한쪽을 선택하지 않고 양쪽을 함께 표시하거나 abstain한다.

---

## 9. Feedback Loop Layer

### 9.1 실패 상태 → Recovery Action

| 실패 신호 | Critic 판정 | Supervisor 승인 시 액션 |
|---|---|---|
| graph worker 실패 / 필요한 관계 evidence 없음 | `REQUIRED_GRAPH_WORKER_FAILED`, `REQUIRED_GRAPH_EVIDENCE_MISSING` | `run_graph_retrieval` |
| 수치·표/그림 evidence 없음, document worker 실패 | `REQUIRED_NUMERIC_EVIDENCE_MISSING`, `NUMERIC_MISMATCH`, `LOCATOR_MISSING` 등 | `run_document_block_retrieval` |
| 원문 발언 evidence 없음, hybrid worker 실패, citation 부족 | `REQUIRED_PRIMARY_SOURCE_QUOTE_MISSING`, `INSUFFICIENT_PRIMARY_EVIDENCE`, `CITATION_COVERAGE_LOW` | `run_hybrid_text_retrieval` (동의어 확장 포함) |
| 위 세 조건에 해당하지 않는 claim 실패 | 기타 claim 실패 | `remove_claim` |
| entity ambiguous, worker 실행 전 | `ENTITY_AMBIGUOUS`/`ENTITY_UNRESOLVED` | `ask_clarification` |
| 상충 evidence 발견 | `evidence_conflict` | `abstain` (임의 선택 금지) |
| retries_remaining <= 0 | `RETRY_BUDGET_EXHAUSTED` | `abstain` |

Supervisor는 `config.supervisor.allowed_recovery_actions`에 없는 action은 자동으로 `abstain`으로 강등하고, `(worker, input_hash, failure_code)` 조합이 `max_same_failure_retries`를 넘으면 같은 원인으로는 더 이상 재시도하지 않는다.

### 9.2 Failure Taxonomy 연결

recovery 판정과 harness 사후 점검은 모두 [00_overview.md §9](../00_overview.md)의 F1~F8 코드로 태깅된다. 이 분류가 있어야 retrieval 병목인지 reasoning 병목인지 분리할 수 있다.

---

## 10. Trace / Observability

`AgentRunResult`(orchestrator)와 `PipelineHarness.evaluate_online_query()`(harness/runtime.py)가 함께 아래 trace를 남긴다.

### 10.1 CitationLedger (session 단위 불변 기록)

- `query_id`, `request_timestamp`, tenant/user scope hash
- `query_spec`, `retrieval_policy`, `memory_selection`(내용은 hash만 기록, 원문 비저장)
- `tool_calls`: worker/selected_by/status/latency/output_ids/backend/snapshot_id
- `llm_calls`: stage/model/prompt_version/temperature/input_hash/output_hash/status
- `claim_evidence_mapping`, `claim_text_hashes`, `claim_verdicts`
- `gate_history`, `recovery_history`
- `final_answer_hash`, `config_hash`

ledger 파일은 `config.audit.ledger_dir`에 session마다 하나씩, 덮어쓰기 불가능한 방식(`"x"` 모드)으로 저장된다.

### 10.2 harness trace 파일

`harness/runtime.py`는 online query 1회 실행마다 아래 파일을 `online_registry_dir`에 남긴다.

- `query_trace.json` — raw/normalized query, planner confidence, risk class
- `retrieval_trace.json` — seed/retrieved node·edge id, pruning 통계, retrieval mode
- `evidence_trace.json` — event별 selected evidence id, ranking signal, contradiction 포함 여부
- `reasoning_trace.json` — 생성된/채택된/기각된 hypothesis
- `answer_trace.json` — 최종 답변, cited evidence id, risk flag, latency
- `verification.json`, `orchestration_trace.json`(query_spec/policy/worker_results/claims/verdicts/ledger 요약), `run_record.json`

이 trace가 있어야 "왜 틀렸는가"를 자동으로 읽을 수 있고, retrieval 문제인지 reasoning 문제인지 분리할 수 있다.

---

## 11. Human-in-the-loop

다음 조건에서만 인간 개입을 요청한다.

- high-risk decision
- low-confidence output
- repeated system failure

구체적인 트리거:

- entity ambiguity가 높고 핵심 answer에 직접 영향 (`clarification` 상태, `human_review_required` 아님 — 사용자에게 먼저 재질문)
- Answer Gate가 `abstain`으로 종료 (`human_review_required = True`)
- `PipelineHarness`가 advice-risk 키워드를 임계치 이상 감지 (F7)
- 답변 confidence가 `human_review_confidence_threshold` 미만
- Supervisor의 재시도 예산 소진

`human_review_required = True`인 경우 `harness/runtime.py`가 `review_ticket`(run_id, risk_class, failure_codes, trace_paths)을 답변에 첨부한다.

---

## 12. 관련 문서

- [02_query_understanding_and_routing.md](02_query_understanding_and_routing.md)
- [03_retrieval_workers.md](03_retrieval_workers.md)
- [04_evidence_and_claims.md](04_evidence_and_claims.md)
- [05_verification_and_answer_gate.md](05_verification_and_answer_gate.md)
- [06_recovery_memory_and_harness.md](06_recovery_memory_and_harness.md)
- [../06_pipeline_runtime/02_online_query_pipeline.md](../06_pipeline_runtime/02_online_query_pipeline.md)
