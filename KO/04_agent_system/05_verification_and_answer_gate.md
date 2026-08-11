# 05. 결정적 Claim Verifier와 Answer Gate

## 1. 목적

생성된 `AtomicClaim` 각각을 그것이 인용한 evidence와 대조해 **entailment, 수치/단위, 시점, 귀속, 관계 방향**을 검증하고, 그 결과를 모아 답변 전체를 `pass`/`repair`/`abstain`으로 게이팅한다. 이 모듈은 의도적으로 LLM judge를 쓰지 않는다 — 재현 가능한 baseline을 먼저 통과해야, 이후 모호한 사례에만 별도 LLM judge를 붙이는 확장이 안전해진다.

`agent/verification.py`의 `VerificationPipeline`이 `DeterministicClaimVerifier`(claim-evidence pair 검증)와 `AnswerGate`(claim 집합 → 최종 게이트)를 감싼다.

---

## 2. Claim 단위 사전 검사

pair 검증 이전에 claim 자체를 거른다.

- **원자성(atomicity)**: 한 claim에 여러 문장/절이 섞여 있으면(`;` 또는 복수 문장) `invalid`로 즉시 거부 — 검증 단위가 쪼개지지 않은 claim은 부분 실패를 표현할 수 없다.
- **citation 존재**: `evidence_ids`가 비어 있으면 `unsupported`(`citation_missing`).

---

## 3. Claim-Evidence Pair 검증 (`verify_pair`)

각 `(claim, evidence)` 쌍마다 아래를 독립적으로 계산하고, entailment 판정에 반영한다.

### 3.1 Entailment (lexical, 정밀도 우선)

- 정확 부분 문자열 일치(공백/특수문자 제거 후 압축 비교)면 `support`.
- 그 외에는 `unknown`으로 남긴다 — 의역(paraphrase)은 이 결정적 baseline이 함부로 `support`로 승격하지 않는다(`semantic_verifier_required_for_paraphrase`). 이후 numeric/relation 검증이 별도로 `support`를 부여할 수 있다.
- claim과 evidence의 부정 표현(`아니다`, `없다`, `not` 등)이 다르면 `contradict`.
- 사전에 정의된 반의어 쌍(증가↔감소, 강화↔약화 등)이 각각 등장하면 `contradict`(`semantic_opposition`).

### 3.2 관계 방향과 인과 (`_relation_semantics`)

- claim에 인과 마커(cause, lead to, 초래, 야기 등)가 있는데 evidence에는 없으면 `fail`/`unknown` — 근거의 인과 표현 부재를 반대 증거로 취급하지 않는다.
- 방향이 있는 관계 표현(공급/인수 등)을 claim과 evidence에서 각각 추출해 주어·목적어가 뒤집혀 있으면 `fail`/`contradict`(`relation_direction_reversed`).

### 3.3 Numeric (`_verify_numeric`)

- 퍼센트/원화/외화/개수 표현을 `Decimal`로 파싱해 부동소수점 오차 없이 비교한다.
- claim의 모든 수치가 **하나의 원자적 evidence scope**(문장/절, 표의 한 행, table_cell 하나) 안에서 동시에 일치해야 한다 — 표 전체에서 지표명은 한 행, 값은 다른 행에서 가져와 끼워 맞추는 것을 방지.
- 증감률(%) claim은 같은 scope의 두 절대값으로 `(현재-이전)/|이전|*100`을 재계산해서 대조한다(`_derived_growth_match`) — evidence에 미리 계산된 증감률이 없어도 검증 가능.
- OCR/vision으로 파생된 수치(`derivation`)는 `human_reviewed=True`가 아니면 무조건 `fail`(`derived_visual_numeric_requires_human_review`).
- 단위·통화가 다르면(예: `%` vs `%p`) 명시적으로 `fail`.

### 3.4 Temporal (`_verify_temporal`)

- `evidence.published_at`이 `as_of` 이후면 `fail`(`evidence_published_after_as_of`) — 미래 정보 유출 차단.
- claim에 명시된 기간(분기/연도/날짜)이 evidence의 기간·섹션·표 헤더·캡션에 없으면 `fail`(`claim_period_not_supported`).

### 3.5 Attribution (`_verify_attribution`)

- claim에서 "OO는 ~라고 밝혔다" 형태의 발화 주체를 추출해, evidence의 `source_name`/`locator.speaker`/본문과 대조한다. 일치하지 않으면 `fail`.

### 3.6 Locator (`_has_clickable_locator`)

- `citable`이고 `source_url`이 있어도, 페이지/anchor/문단/표 위치 중 하나가 없으면 `fail` — "클릭했을 때 실제로 그 위치로 갈 수 있는가"를 별도로 검증한다.

### 3.7 유효한 지지/반박의 정의

```text
valid_support   = entailment == "support"
                   AND numeric/temporal/attribution/relation_status != "fail"
                   AND locator_status == "pass"
valid_contradiction = entailment == "contradict"
                   AND temporal_status != "fail"
                   AND locator_status == "pass"
```

---

## 4. Claim 상태 결정 (`verify_claim`)

인용된 evidence만이 아니라, **인용되지 않은 다른 검색 결과 중에서도 같은 지표·기간을 다루는 후보를 찾아 재대조**한다(`_is_reconciliation_candidate`) — 생성기가 유리한 쪽 출처만 골라 인용하고 상충하는 다른 출처를 숨기지 못하게 하기 위함이다.

| 조건 | claim status |
|---|---|
| valid support와 valid contradiction이 모두 존재 | `conflict` |
| valid support는 있지만 다른 인용이 무효 | `invalid` (하나의 좋은 출처가 나머지 무효 인용을 덮지 못함) |
| valid support만 존재 | `supported` |
| valid contradiction만 존재 | `contradicted` |
| evidence 누락 또는 numeric/temporal/attribution/relation/locator 중 하나라도 `fail` | `invalid` |
| 그 외 | `unsupported` |

`supported`로 판정된 뒤에도 추가로 다음을 확인한다.

- claim이 질의가 요청한 기간과 실제로 맞는가 (`_claim_matches_query_period`)
- `time.value == "latest_available"` 질의라면, 인용된 evidence가 실제로 관련 후보 중 가장 최신인가 (`_supports_are_latest`)
- claim이 원 질문의 focus 토큰과 관련 있는가 (`_query_claim_relevance`) — evidence는 맞지만 질문과 무관한 사실을 끼워 넣는 것을 방지

이 중 하나라도 실패하면 `supported`였던 claim도 `unsupported`로 강등된다.

---

## 5. Answer Gate

`AnswerGate.evaluate()`는 claim 목록과 verdict를 받아 최종 결정을 만든다.

```text
critical_coverage = 지지된 critical claim 비율
coverage          = 지지된 core(=supporting이 아닌) claim 비율

blocking 조건 (하나라도 해당하면 즉시 차단):
  - critical claim이 contradicted
  - 어떤 claim이든 conflict 상태
  - critical claim의 수치 검증 실패 (block_critical_numeric_failure)
  - 귀속 검증 실패 (block_attribution_failure)
  - critical claim의 evidence가 as_of 이후 발행됨 (critical_temporal_leakage)

decision =
  pass    if thresholds 통과 AND 실패 claim 없음 AND blocking 없음
  abstain if blocking 조건 성립
  repair  그 외 (재시도/재계획 대상)
```

`critical_citation_coverage`/`normal_citation_coverage` 임계값 미만이면 각각 별도 reason code(`critical_citation_coverage_below_threshold`, `citation_coverage_below_threshold`)가 추가된다.

### 5.1 왜 conflict는 repair가 아니라 abstain인가

지지 evidence와 반박 evidence가 둘 다 유효하면, 어느 한쪽을 임의로 골라 재시도해도 "진짜 답"을 찾을 수 없다. 이런 경우 시스템은 재검색으로 문제를 해결하려 하지 않고 상충을 그대로 노출하거나(`_render_answer`의 `conflicts` 필드) 답변을 유보한다.

---

## 6. 데이터 흐름 내 위치

```text
[ClaimFirstGenerator]  (04_evidence_and_claims.md)
        │  List[AtomicClaim]
        ▼
[DeterministicClaimVerifier.verify()]   ← 이 문서
        │  List[ClaimVerdict]
        ▼
[AnswerGate.evaluate()]   ← 이 문서
        │  AnswerGateDecision (pass / repair / abstain / clarification)
        ├─ pass  → Answer Renderer (06_recovery_memory_and_harness.md)
        └─ 그 외 → CriticAgent → Supervisor  (06_recovery_memory_and_harness.md)
```

---

## 7. Harness 관점의 검증 포인트

| 항목 | 의미 |
|------|------|
| `citation_coverage` / `critical_citation_coverage` | 핵심 주장에 지지 evidence가 충분한가 |
| `conflict_rate` | 상충 evidence가 얼마나 자주 발견되는가 |
| `numeric_verification_fail_rate` | 수치·단위·기간 재계산이 얼마나 자주 실패하는가 |
| `unknown_entailment_rate` | 정확 일치가 아니어서 `unknown`으로 남는 비율 (의미 기반 judge 도입 필요성의 신호) |
| `locator_fail_rate` | citable이지만 클릭 가능한 위치가 없는 evidence 비율 |
| `answer_gate_decision distribution` | pass/repair/abstain 비율 |

대표 실패 유형: F3 숫자 오류(Numeric fail), F2 시간축 오류(Temporal fail), F4 이벤트 귀속 오류(Attribution fail), F6 추론 과장(Relation fail).

---

## 8. 설계 의사결정 근거

**왜 LLM judge 없이 결정적 검증을 먼저 두는가?**
LLM judge는 유용하지만 스스로도 오판할 수 있어, 검증 계층 전체를 LLM에 맡기면 "생성 모델의 실수를 생성 모델이 검증"하는 순환 위험이 생긴다. 정밀도 우선 baseline(exact match, Decimal 재계산, 명시적 반의어/방향 규칙)을 먼저 통과시키고, 모호한 의역 판정처럼 baseline이 원천적으로 `unknown`을 반환하는 사례에만 별도 judge를 얹는 확장 경로를 남긴다.

**왜 표 전체가 아니라 "하나의 scope" 안에서만 수치를 대조하는가?**
표에는 여러 지표·기간이 같은 문서에 섞여 있다. 지표명이 있는 행과 수치가 있는 행을 다른 곳에서 각각 가져와 짜맞추면 실제로는 존재하지 않는 조합을 "확인됨"으로 만들 수 있다. 하나의 행/문장/셀 단위로 강제하면 이런 거짓 긍정을 막는다.

**왜 uncited(인용되지 않은) 후보도 재대조하는가?**
생성기가 유리한 쪽 출처만 골라 인용하면 검증 계층이 그 편향을 그대로 통과시킨다. 검색된 다른 후보 중 같은 지표·기간을 다루는 것이 있으면 강제로 재대조해, 상충하는 근거를 숨기지 못하게 한다.
