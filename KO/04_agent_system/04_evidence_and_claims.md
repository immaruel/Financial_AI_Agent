# 04. Evidence Requirement Gate, Context Builder, Claim-first Generator

## 1. 목적

검색된 `EvidenceBlock` 목록이 있다고 해서 곧바로 LLM이 답변을 생성하지 않는다. 먼저 **질문이 요구한 근거 modality가 실제로 채워졌는지 코드로 사전 차단**하고(`EvidenceRequirementGate`), 통과한 evidence만 예산 안에서 컨텍스트로 조립한 뒤(`ContextBuilder`), LLM은 그 컨텍스트 밖의 evidence ID를 인용할 수 없는 상태로 atomic claim만 생성한다(`ClaimFirstGenerator`).

이 세 컴포넌트는 "답변이 근거 부족인지, retrieval은 됐지만 생성 단계가 못 쓴 것인지"를 분해하는 핵심 경계다.

---

## 2. Evidence Requirement Gate

`EvidenceRequirementGate.evaluate()`(`agent/requirements.py`)는 LLM을 호출하지 않는다. `QuerySpec.evidence_needs`의 `required` 항목마다 실제로 인용 가능한 evidence가 있는지 확인한다.

### 2.1 admissibility 기본 조건

evidence가 아래를 모두 만족해야 "인용 가능(admissible)"으로 취급된다.

- `citable=True`, `synthetic=False`
- `source_url`과 `text`가 비어 있지 않음
- 구체적인 locator(`page`/`xpath`/`css_selector`/`paragraph_id`/`table_id`/`char_start·end` 중 하나)가 있음
- `published_at`이 `as_of` 이전(미래 정보 유출 방지)

### 2.2 need별 판정

| need | 통과 조건 | 실패 시 reason code |
|---|---|---|
| `graph_relation = required` | graph worker가 성공했고, 의미 있는 관계 타입(`AFFECTS`, `CAUSED_BY`, `BELONGS_TO_INDUSTRY` 등)을 포함하며 admissible evidence로 뒷받침되는 path가 있음. 질문이 인과("원인", "왜")를 물으면 그 path의 edge가 `causal=True`이고 `inference_method`가 시간 인접 휴리스틱이 아니어야 함 | `REQUIRED_GRAPH_WORKER_FAILED`, `REQUIRED_GRAPH_EVIDENCE_MISSING`, `REQUIRED_CAUSAL_GRAPH_EVIDENCE_MISSING` |
| `primary_source_quote = required` | 1차 출처(`filing`/`earnings_transcript`/`ir`/`government` 등)의 `paragraph`/`footnote` block이 있고, 경영진 관련 질문이면 화자 정보(`locator.speaker` 등)까지 확인 | `REQUIRED_PRIMARY_SOURCE_QUOTE_MISSING` |
| `numeric_value = required` | 연도만 있는 게 아니라 실제 금액/비율/개수 표현이 있는 admissible evidence가 있음 | `REQUIRED_NUMERIC_EVIDENCE_MISSING` |
| `table_or_figure = required` | 표는 위치+구조(`grid`/`headers`/`row_index` 등)가 모두 있고, 그림은 위치+사람 검토(`human_reviewed`)+실제 이미지 자산+OCR/vision 결과가 모두 있음 | `REQUIRED_STRUCTURED_VISUAL_EVIDENCE_MISSING` |

하나라도 실패하면 `AnswerGateDecision(decision="repair", ...)`을 반환해 생성 단계로 넘어가지 않고 바로 Critic/Supervisor 복구 루프로 보낸다. 모두 통과하면 `decision="pass"`.

---

## 3. Context Builder

`ContextBuilder.build()`(`agent/context_builder.py`)는 evidence-ID allowlist가 있는 `ContextBundle`을 만든다.

### 3.1 조립 순서와 예산 관리

```text
1. as_of 이후 발행된 evidence, 비인용/synthetic evidence 제외, content_hash로 중복 제거
2. policy.evidence_budget 개수만큼 evidence 선택
3. [QUERY SPEC] 섹션: query_id, 원 질문, intent, entities, time, evidence_needs
4. [EVIDENCE BLOCKS] 섹션: 이 안의 evidence_id만 인용 가능하다고 명시
5. mode != "hybrid_only"면 [GRAPH RELATION CONTEXT]와 [TIMELINE] 섹션 추가
6. memory가 selected 상태면 [USER PREFERENCES — NOT FACTUAL EVIDENCE; NEVER CITE] 섹션 추가
```

`mode`는 `graph_hybrid`/`graph_primary`/`hybrid_only` 중 하나로, 선택된 채널 조합에서 결정적으로 계산된다.

### 3.2 완전한 레코드만 포함

문자를 임의로 잘라 넣지 않는다. 예산이 부족하면 evidence 항목 전체를 통째로 포함하거나 제외하며, 반쯤 잘린 JSON 객체를 컨텍스트에 남기지 않는다 — 그렇지 않으면 생성과 citation 감사(audit) 결과가 서로 어긋난다. 표/그림 block의 `structured` 필드도 예산을 넘으면 `{"truncated": true, "preview": "..."}` 형태로만 축약한다.

### 3.3 메모리는 별도 섹션, 별도 규칙

사용자 메모리는 `[USER PREFERENCES — NOT FACTUAL EVIDENCE; NEVER CITE]` 헤더로 명확히 분리되고, evidence-ID allowlist에 포함되지 않는다. `ContextBundle.content_hash`는 렌더링된 전체 컨텍스트의 sha256으로, ledger가 "LLM에 실제로 무엇이 들어갔는지"를 재현할 수 있게 한다.

---

## 4. Claim-first Generator

`ClaimFirstGenerator.generate()`(`agent/generation.py`)는 자유 서술형 답변을 먼저 만들지 않는다. 항상 atomic claim 목록을 먼저 만든다.

### 4.1 System Prompt

```text
당신은 금융 리서치 Claim-first Generator다.
사용자 질문과 제공된 EvidenceBlock만 사용해 atomic claim JSON을 작성하라.
규칙:
1. 한 claim에는 독립적으로 검증 가능한 사실 하나만 넣는다.
2. evidence_ids에는 context에 있는 evidence_id만 사용한다.
3. 사용자 메모리는 선호도일 뿐 사실 근거가 아니며 인용하지 않는다.
4. 숫자·단위·통화·기간을 근거와 동일하게 유지한다.
5. PRECEDES 또는 POSSIBLY_RELATED_AFTER를 인과관계로 바꾸지 않는다.
   특히 edge_metadata.causal=false인 경로는 시간 인접 검색 단서일 뿐이다.
6. 근거가 없으면 claim을 만들지 않는다.
7. 지정된 JSON Schema 밖의 필드를 출력하지 않는다.
```

### 4.2 AtomicClaim 구조

```json
{
  "claims": [
    {
      "claim_id": "c1",
      "text": "매출은 전년 동기 대비 18% 증가했다.",
      "claim_type": "numeric",
      "evidence_ids": ["ev_456"],
      "importance": "critical"
    }
  ]
}
```

### 4.3 허용 목록 강제와 fallback

```text
1. LLM 호출 → 스키마 검증 + evidence_id allowlist 검증
   (context.evidence_ids 밖의 ID를 인용하면 즉시 거부)
2. critical claim에 evidence_ids가 비어 있으면 거부
3. 검증 실패 시 허용 evidence_id 목록을 다시 명시한 repair prompt로 1회 재요청
4. 재실패 시 결정적 fallback: 상위 evidence 4개에서 문장을 그대로 추출해
   claim_type(numeric/temporal/attribution/factual)을 규칙으로 분류
```

`fallback`은 문장을 새로 생성하지 않고 evidence 원문에서 첫 문장을 그대로 잘라 쓰므로, LLM이 완전히 실패해도 근거 없는 문장이 나올 수 없다.

---

## 5. 데이터 흐름 내 위치

```text
[Retrieval Worker들] → EvidenceBlock 목록
        ▼
[Evidence Fusion & Rerank] (03_retrieval_workers.md)
        ▼
[EvidenceRequirementGate]   ← 이 문서
        │ pass만 통과
        ▼
[ContextBuilder]   ← 이 문서
        ▼
[ClaimFirstGenerator]   ← 이 문서
        │ List[AtomicClaim]
        ▼
[DeterministicClaimVerifier + AnswerGate]  (05_verification_and_answer_gate.md)
```

---

## 6. Harness 관점의 검증 포인트

| 항목 | 의미 |
|------|------|
| `requirement_gate_block_rate` | 얼마나 자주 생성 이전에 근거 부족으로 차단되는가 |
| `context_budget_utilization` | evidence_budget 대비 실제 포함된 evidence 비율 |
| `claim_allowlist_violation_rate` | LLM이 컨텍스트 밖 evidence를 인용하려 한 비율(1회 repair로 회복됐는지 포함) |
| `fallback_generation_rate` | 결정적 fallback으로 강등된 비율 |
| `critical_claim_without_evidence_rate` | critical claim이 근거 없이 생성되려다 거부된 비율 |

대표 실패 유형: F5 근거 누락(Gate 차단), F6 추론 과장(허용되지 않은 인과 편입 시도).

---

## 7. 설계 의사결정 근거

**왜 생성 이전에 별도 Gate를 두는가?**
LLM이 근거 없이도 그럴듯한 문장을 만들 수 있기 때문에, "근거가 있는지"는 생성 결과를 검증해서 사후에 알아내는 것보다 생성 이전에 결정적으로 차단하는 편이 비용과 안전성 모두에서 유리하다. Gate를 통과하지 못하면 LLM을 아예 호출하지 않는다.

**왜 claim을 먼저 만들고 서술형 답변은 나중에 조립하는가?**
자유 서술형 답변은 문장 하나에 여러 사실이 섞여 검증 단위를 나눌 수 없다. Claim 단위로 쪼개면 각 claim을 독립적으로 검증하고, 실패한 claim만 제거하거나 재검색할 수 있다 ([05_verification_and_answer_gate.md](05_verification_and_answer_gate.md), [06_recovery_memory_and_harness.md](06_recovery_memory_and_harness.md)).

**왜 fallback이 "새 문장 생성"이 아니라 "evidence 원문 추출"인가?**
LLM이 완전히 실패한 상황에서도 fallback이 새로운 문장을 만들면 근거 없는 진술이 나올 위험이 있다. 원문에서 그대로 추출하면 최소한 "이 문장은 evidence에 실제로 존재한다"는 보장이 유지된다.
