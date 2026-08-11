# 06. Critic/Supervisor 복구, 사용자 메모리, 위험 관리

## 1. 목적

Answer Gate가 `pass`가 아니면 누가, 어떤 규칙으로 재시도·재계획·중단을 결정하는지(Critic/Supervisor), 사용자 개인화가 어떻게 사실 근거와 분리되어 주입되는지(User Memory), 그리고 최종 답변 전에 안전성이 어디서 다시 한 번 점검되는지(Risk & Harness)를 정의한다.

---

## Part 1: Critic와 Supervisor

### 1.1 역할 분리

| 역할 | 클래스 | 책임 |
|---|---|---|
| Critic | `CriticAgent` (`agent/supervisor.py`) | gate reason code + worker failure를 읽고 **다음 행동 후보**를 진단 |
| Supervisor | `Supervisor` (`agent/supervisor.py`) | Critic의 제안 중 **허용된 action만 승인**하고, 동일 실패의 반복 재시도를 차단 |

Critic은 답변을 칭찬·비난하지 않는다. 항상 `RecoveryDecision(decision, reason_codes, failed_claim_ids, next_actions)` 형태의 구조화된 진단만 반환한다.

### 1.2 진단 우선순위 (`CriticAgent.diagnose`)

```text
1. entity ambiguous/unresolved인데 아직 worker를 하나도 안 돌렸다면
   -> decision="clarification", action=ask_clarification
2. retries_remaining <= 0
   -> decision="abstain", reason += RETRY_BUDGET_EXHAUSTED
3. evidence_conflict 또는 claim_conflict가 reason에 있으면
   -> decision="abstain" (상충 근거는 재시도로 해결되지 않음, CONFLICT_REQUIRES_DISCLOSURE)
4. graph worker 실패 계열 코드
   -> action=run_graph_retrieval
5. document-block worker 실패/수치·시간·귀속 검증 실패 계열 코드
   -> action=run_document_block_retrieval
6. hybrid worker 실패/citation 부족 계열 코드
   -> action=run_hybrid_text_retrieval (filters.expand_terms=True)
7. 그 외 claim 실패
   -> action=remove_claim
```

### 1.3 Supervisor의 통제

```python
def register_failure(self, worker, input_hash, failure_code) -> bool:
    key = (worker, input_hash, failure_code)
    self._attempts[key] += 1
    return self._attempts[key] <= self.config.max_same_failure_retries

def authorize(self, decision: RecoveryDecision) -> RecoveryDecision:
    approved = [a for a in decision.next_actions if a.action in self.config.allowed_recovery_actions]
    if not approved:
        return RecoveryDecision(decision="abstain", reason_codes=[..., "RECOVERY_ACTION_REJECTED"], ...)
    return decision.model_copy(update={"next_actions": approved})
```

- `allowed_recovery_actions`에 없는 action은 Critic이 제안해도 자동으로 `abstain`.
- `(worker, input_hash, failure_code)` 조합이 `max_same_failure_retries`를 넘으면 같은 원인으로는 더 이상 재시도하지 않는다 — 같은 검색을 무한 반복하지 않기 위한 장치.
- `Supervisor.reset()`은 질의(세션) 시작마다 호출되어 이전 질의의 재시도 카운터가 새 질의에 영향을 주지 않게 한다.

### 1.4 재시도 실행

`AgentOrchestrator._run_recovery_worker()`가 승인된 action을 실제 worker 호출로 옮긴다.

| action | 실행 |
|---|---|
| `run_graph_retrieval` | policy를 복사해 `channels`에 `graph` 추가, `graph_mode="assist"`로 재실행 |
| `run_document_block_retrieval` | policy를 `channels=["document_block"]`로 좁혀 재실행 |
| `run_hybrid_text_retrieval` | `expand_terms=True`면 의도별 확장어(경영진/관계/영향 등)를 결정적으로 추가한 `QuerySpec` 사본으로 재검색. `source_filters`도 초기화해 범위를 넓힘. `as_of`와 intent는 절대 바꾸지 않는다 |
| `remove_claim` | 실패한 claim만 제거하고 남은 claim으로 재검증. 재검증도 실패하면 abstain |

재시도로 얻은 evidence는 기존 evidence와 함께 다시 fusion/rerank되고, gate → generation → verification 루프가 반복된다. 루프는 `while True`이지만 매 반복마다 retry budget이 줄고 Supervisor가 반복 실패를 차단하므로 무한 루프가 되지 않는다.

---

## Part 2: 사용자 메모리

### 2.1 원칙

사용자 메모리는 **사실 근거가 아니다.** 답변의 관점·비교 기준·관심 리스크를 정하는 보조 context일 뿐이며, 기업 사실 claim의 citation을 절대 대체하지 않는다. `UserMemoryStore`(`agent/memory.py`)는 질의 처리 과정에서 자동으로 메모리를 생성하지 않는다 — `write`/`create`/`update`/`delete`처럼 명시적으로 호출된 경우에만 메모리가 바뀐다.

### 2.2 저장 구조

```json
{
  "memory_id": "mem_...",
  "tenant_id": "tenant_a",
  "user_id": "user_1",
  "kind": "investment_framework",
  "content": {"risk_preference": "conservative", "focus": ["cash_flow"]},
  "entities": ["company:005930"],
  "industries": ["semiconductor"],
  "intents": [],
  "valid_from": "2026-01-01T00:00:00+09:00",
  "valid_until": null,
  "created_at": "2026-01-01T00:00:00+09:00",
  "source": "explicit_user_feedback",
  "superseded_by": null
}
```

- `anonymous`는 안정적인 사용자 식별자로 취급하지 않는다 — `user_id`가 비어 있거나 `anonymous`면 메모리 선택 자체를 `disabled`로 반환한다(다른 방문자에게 유출 방지).
- `update()`는 기존 레코드를 직접 수정하지 않고 새 ID로 버저닝하며 이전 레코드에 `superseded_by`를 남긴다 — 과거에 감사된 답변이 어떤 선호 버전을 사용했는지 재현 가능하다.
- 영속 저장(`persistent=True`)은 opt-in이며, `MemoryConfig.require_encryption=True`이면 Fernet 키가 없는 한 저장을 거부한다.

### 2.3 관련성 선택 (`UserMemoryStore.select`)

`QuerySpec`과 메모리 메타데이터만으로 결정적으로 계산한다 — LLM을 호출하지 않는다.

```text
1. tenant/user 범위, valid_from/valid_until, superseded 여부로 유효 레코드만 남김
2. 같은 kind/entities/industries/intents 조합(conflict key)에서 여러 활성 레코드가 있으면
   가장 최근 것만 채택하고 나머지는 conflict_shadowed_by_newer로 제외
3. entity/industry/intent 태그가 질의와 겹치면 가점(태그가 있는 메모리 우선)
4. 태그가 전혀 없는 메모리는 질의 원문과의 어휘 overlap만 fallback으로 사용
5. min_rule_score 미만은 제외, 점수 순으로 max_selected_memories/token_budget 안에서 선택
```

선택 결과(`MemorySelection`)는 `status`, `memory_ids`, `reasons`, `excluded`(사유 포함)를 모두 담아 ledger에 감사 가능하게 기록된다. 다만 ledger에는 메모리 **내용**이 아니라 `content_hash`만 남는다.

### 2.4 답변에 노출되는 방식

`ContextBuilder`가 메모리를 `[USER PREFERENCES — NOT FACTUAL EVIDENCE; NEVER CITE]` 섹션으로만 컨텍스트에 넣고, `ClaimFirstGenerator`의 프롬프트도 "사용자 메모리는 선호도일 뿐 사실 근거가 아니며 인용하지 않는다"를 명시한다. 최종 `StructuredAnswer.risk_warnings`에도 동일한 고지가 고정 문구로 포함된다.

---

## Part 3: Risk 관리와 Harness 사후 점검

### 3.1 세 층의 안전 장치

| 층 | 시점 | 방식 |
|---|---|---|
| Evidence Requirement Gate | 생성 이전 | 근거 modality 사전 차단 ([04_evidence_and_claims.md](04_evidence_and_claims.md)) |
| Answer Gate | 생성 이후, claim 단위 | citation/수치/시간/귀속 검증 실패 시 차단 ([05_verification_and_answer_gate.md](05_verification_and_answer_gate.md)) |
| Harness post-check | 답변 확정 이후 | `PipelineHarness`(`harness/runtime.py`)가 F1~F8 taxonomy로 재점검하고 review 필요 여부 결정 |

세 층은 서로 다른 실패를 잡는다. 앞의 두 층은 "이 주장이 근거로 뒷받침되는가"를 보고, harness 층은 "그럼에도 남아 있는 투자 권유·과신 표현, 최신성 문제, human review 필요 여부"를 본다.

### 3.2 Answer Renderer (`AgentOrchestrator._render_answer`)

Gate를 통과한 claim만 최종 답변에 들어간다.

```text
gate.decision == "pass"        -> accepted claim들로 summary 구성, status="completed"
claim conflict가 하나라도 있음  -> 어느 쪽도 확정하지 않고 지지/반박 evidence를 함께 노출, status="partial"
gate.decision == "clarification" -> 대상/기간을 재질문, status="clarification"
그 외 (abstain 등)              -> "현재 기준 시점까지 확보한 검증 가능한 원문 근거만으로는
                                    이 질문에 신뢰성 있게 답할 수 없습니다.", status="abstained"
```

모든 답변에는 아래 고정 경고가 포함된다.

```text
"사용자 메모리는 개인화에만 사용되며 사실 근거로 인용되지 않습니다."
"본 답변은 원문 근거 확인을 돕는 리서치 자료이며 투자 권유가 아닙니다."
```

### 3.3 Harness의 F1~F8 사후 점검 (`PipelineHarness._verify_online`)

`harness/runtime.py`는 `AgentRunResult`를 다시 훑어 아래를 확인하고 `VerificationSummary`/`FailureCase`를 만든다.

| 점검 | 코드 |
|---|---|
| graph가 선택됐는데 seed/subgraph가 비어 있음 | F1 |
| 인용 가능한 EvidenceBlock을 전혀 못 찾음, 핵심 event 대비 evidence 부족 | F5 |
| 상충 evidence가 있는데 답변의 counter-evidence에 반영 안 됨 | F5 |
| 최종 답변에 출처가 없음 | F5 |
| Answer Gate가 pass가 아님 | F5 |
| 투자 권유/과신 키워드(`매수`, `매도`, `추천`, `보장`, `확실`, `반드시` 등)가 임계치 이상 검출 | F7 |
| 질의가 `high-risk`(매수/매도/추천 등 키워드)로 분류됐는데 답변 confidence가 낮음 | F7 |
| 답변 confidence가 낮음 | F8 |

이 키워드 기반 advice-risk 검사는 claim 검증과는 독립적으로 동작하는 **마지막 방어선**이며, 검증을 모두 통과한 문장에서도 위험 표현이 남아 있는지 다시 확인한다. `_apply_online_feedback()`은 이 결과로 `risk_warnings`를 보강하고 `human_review_required`를 갱신하지만, gate를 통과한 claim의 본문 텍스트 자체는 수정하지 않는다 — ledger 해시와 실제 반환 답변이 어긋나지 않도록 하기 위함이다.

### 3.4 Human Review

`human_review_required=True`가 되면 `review_ticket`(run_id, risk_class, failure_codes, trace_paths)이 답변에 첨부된다. human_review가 필요한 조건은 [01_agent_architecture.md §11](01_agent_architecture.md)을 따른다.

### 3.5 실시간 보완 수집과의 연결

Answer Gate가 재시도 예산을 다 쓰고도 `abstain`으로 끝나면서 근본 원인이 "KG/corpus에 정보 자체가 없음"(`RETRIEVAL_EMPTY`/`INSUFFICIENT_PRIMARY_EVIDENCE`이고 retryable)일 때만, `main.py`의 `FinancialKGPipeline.query()`가 실시간 보완 수집(`_online_supplement`)을 1회 실행하고 KG를 병합한 뒤 같은 질의를 재실행한다. 다른 모든 재시도 채널(그래프/문서/원문 확장)은 이 실시간 수집보다 먼저 시도된다 — 자세한 내용은 [06_pipeline_runtime/02_online_query_pipeline.md](../06_pipeline_runtime/02_online_query_pipeline.md)에 정리한다.

---

## 4. Harness 관점의 검증 포인트

| 항목 | 의미 |
|------|------|
| `recovery_success_rate` | Critic/Supervisor 재시도 후 실제로 pass에 도달한 비율 |
| `same_failure_retry_block_rate` | 동일 실패로 재시도가 차단된 빈도 |
| `memory_selection_precision` | 선택된 메모리가 실제로 질의와 관련 있는가 |
| `advice_risk_hit_rate` | harness 사후 점검에서 F7이 얼마나 자주 발생하는가 |
| `human_review_rate` | 전체 질의 중 review_ticket이 발급되는 비율 |

대표 실패 유형: F1/F5(재시도로 회복 시도), F7(harness 사후 점검), F8(과잉 abstain — 재시도 정책이 지나치게 보수적인지 점검).

---

## 5. 설계 의사결정 근거

**왜 self-repair를 무한 반복하지 않는가?**
재검색이 항상 관련 정보를 가져온다는 보장이 없다. `(worker, input_hash, failure_code)` 단위로 반복을 차단하고 `retry_budget`을 두어, 일정 횟수 이후에는 safe failure(`abstain`/`clarification`) 또는 human review로 전환한다.

**왜 harness가 claim 검증과 별도로 키워드 기반 advice-risk를 다시 확인하는가?**
Claim 검증은 "이 문장이 근거로 뒷받침되는가"만 본다. 근거가 있어도 표현 자체가 투자 권유·과신으로 읽힐 수 있으므로, 사실성 검증과 표현 안전성 검증은 서로 다른 계층에서 독립적으로 점검한다.

**왜 harness는 claim 텍스트 자체를 사후에 고치지 않는가?**
Verifier를 통과한 문장을 harness가 사후에 수정하면 `CitationLedger`의 `final_answer_hash`와 실제 반환된 답변이 달라진다. harness는 경고/상태만 덧붙이고, 검증된 claim 본문은 보존한다.
