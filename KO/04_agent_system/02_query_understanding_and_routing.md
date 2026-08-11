# 02. Query Understanding과 Retrieval Policy

## 1. 목적

사용자의 자연어 질의를 LLM이 해석한 초안(`QuerySpecDraft`)으로 바꾸고, 이를 결정적 코드가 검증·확정한 `QuerySpec`으로 만든다. 이어서 `QuerySpec`을 실행 가능한 `RetrievalPolicy`(검색 채널, 예산, retry 횟수)로 변환한다.

하네스 엔지니어링 관점에서 이 두 단계는 **온라인 파이프라인의 첫 번째 failure localization 지점**이다. 이후 retrieval과 claim 검증 품질은 QuerySpec/Policy 품질에 크게 의존하므로, 반드시 trace와 검증 메트릭의 대상이 된다.

---

## 2. Query Understanding Agent

### 2.1 역할 경계

LLM은 질문에 답하지 않는다. `QuerySpecDraft` JSON만 생성하며, 아래는 LLM이 절대 하지 않는 일이다.

- canonical entity ID를 만드는 것 (표면형 `surface`만 추출)
- 검색 tool 이름을 선택하는 것
- 시간 표현이 없을 때 임의로 기간을 추정하는 것 (`time.kind = "unspecified"` 유지)
- `as_of`를 직접 정하는 것 (항상 서버가 전달한 `request_timestamp`)

### 2.2 System Prompt

```text
당신은 금융 리서치 질의의 검색 계획을 만드는 Query Understanding Agent다.

목표:
사용자 질문에 답하지 말고, 질문의 의도와 필요한 근거 유형을
지정된 JSON Schema에 맞춰 추출하라.

규칙:
1. 사용자 질문 밖의 기업 사실, 최신 정보, 수치, 관계를 만들지 말라.
2. entity는 canonical ID가 아니라 질문의 표면형(surface)만 추출하라.
3. 시간 표현이 없으면 time.kind를 "unspecified"로 두고 기간을 추정하지 말라.
4. as_of는 제공된 request_timestamp와 동일하게 설정하라.
5. graph_relation은 관계, 경로, 전이, 다중 hop이 질문의 핵심일 때 required다.
6. primary_source_quote는 경영진 발언, 공시 문구, 직접 근거가 핵심일 때 required다.
7. numeric_value는 금액, 비율, 증감률, 재무수치, 기간 비교가 필요할 때 required다.
8. table_or_figure는 표, 차트, 행/열, 분기별 값, 시각 자료가 필요할 때 required다.
9. 각 need는 required, preferred, not_needed 중 하나만 사용하라.
10. 질문에 답하거나 검색 tool 이름을 선택하지 말라.
11. JSON Schema 밖의 필드나 설명 문장을 출력하지 말라.
```

user message는 `request_timestamp`, `user_query`, Pydantic이 생성한 `QuerySpecDraft` JSON Schema로 구성된다 (`agent/query_understanding.py`의 `_build_user_prompt`).

### 2.3 QuerySpecDraft 예시

```json
{
  "query_id": "q_...",
  "original_query": "삼성전자 CFO는 최근 마진 둔화 원인을 어떻게 설명했나?",
  "request_timestamp": "2026-08-07T10:00:00+09:00",
  "as_of": "2026-08-07T10:00:00+09:00",
  "entities": [{"surface": "삼성전자", "suspected_type": "company"}],
  "intent": "management_explanation",
  "sub_intents": [],
  "question_focus": ["margin_decline_cause"],
  "time": {"kind": "relative", "expression": "최근"},
  "answer_format": "explanation_with_citations",
  "evidence_needs": {
    "graph_relation": "not_needed",
    "primary_source_quote": "required",
    "numeric_value": "not_needed",
    "table_or_figure": "not_needed"
  },
  "memory_mode": "if_relevant",
  "confidence": 0.93
}
```

### 2.4 실패 처리 (`QueryUnderstandingAgent.understand()`)

```text
1. LLM 호출 -> schema/필드 검증
2. 실패 -> validation_error를 포함한 repair prompt로 1회만 재요청
3. 재실패 -> 규칙 기반 결정적 fallback QuerySpecDraft 생성 (validation_status = "planner_fallback")
4. entity가 다의적으로 남음 -> validation_status = "entity_ambiguous"
```

fallback draft는 `_GRAPH_PATTERNS`/`_QUOTE_PATTERNS`/`_NUMERIC_PATTERNS`/`_TABLE_PATTERNS` 정규식과 알려진 entity dict만으로 만들어지며, 질의에 없는 표면형을 추가하지 않는다.

---

## 3. 결정적 검증: `QuerySpecValidator`

LLM 출력은 초안일 뿐이며, 아래는 모두 코드가 확정한다 (`agent/query_understanding.py`).

### 3.1 NeedLevel 보정

`true/false`만으로는 "반드시 필요"와 "있으면 도움이 됨"을 구분할 수 없어 3단계 enum을 쓴다.

```python
class NeedLevel(str, Enum):
    REQUIRED = "required"
    PREFERRED = "preferred"
    NOT_NEEDED = "not_needed"
```

명시적 키워드 신호(관계/공급망/전이 등은 `graph_relation`, 경영진 발언 등은 `primary_source_quote`, 금액/비율 등은 `numeric_value`, 표/차트 등은 `table_or_figure`)가 있으면 LLM 값과 무관하게 `required`로 승격하고, 신호가 전혀 없으면 `graph_relation`/`table_or_figure`는 `not_needed`로 강등한다. 정책/산업/기업 전이 질문(`영향`, `전이`)에서 `graph_relation`이 `required`이면 `primary_source_quote`도 함께 `required`로 올려, graph의 시간 인접성만으로 인과를 단정하지 못하게 한다.

### 3.2 Entity Resolution

`DeterministicEntityResolver`는 애플리케이션이 전달한 `entity_dict`(기업/산업/기관/지역/원자재 alias → canonical ID)만 사용한다. LLM이 제안한 표면형이 실제 질의 문자열에 없으면 버리고(`entity_not_in_query`), 사전에 있는 alias 중 LLM이 놓친 것은 결정적으로 보완한다. 후보가 여럿이면 `ambiguous`, 사전에 없으면 `unresolved`로 표시한다.

### 3.3 Intent / Sub-intent 정규화

`evidence_needs`가 확정된 뒤 intent를 재계산한다 — `graph_relation=required`면 `relationship_lookup`/`impact_analysis`, `primary_source_quote=required`면 `management_explanation`, `table_or_figure=required`면 `document_visual_lookup`, `numeric_value=required`면 `numeric_lookup` 등. LLM이 제안한 intent 문자열은 이 규칙과 충돌하면 무시된다.

### 3.4 시간 표현 파싱

연도 범위, 명시 날짜(구간 포함), 분기(`2026Q1`), 월, 상대 표현(`최근 3개 분기`, `지난 분기`, `올해` 등)을 정규식으로 파싱해 `from_date`/`to_date` 또는 상대 표현 그대로(`value`)를 만든다. **시간 표현이 없으면 `time.kind = "unspecified"`를 유지하며, 임의의 30일/90일 기본 윈도우를 채우지 않는다.**

### 3.5 as_of 고정

`as_of`는 항상 서버가 받은 `request_timestamp`다. LLM이나 실행 중 재조회한 "현재 시각"으로 바뀌지 않으므로 동일 질의를 다른 시각에 재현해도 같은 시점 기준으로 검증할 수 있다.

---

## 4. Retrieval Policy Builder

`RetrievalPolicyBuilder`(`agent/routing.py`)는 LLM을 호출하지 않는다. `QuerySpec.evidence_needs`의 NeedLevel을 코드 규칙으로 채널 집합에 매핑한다.

```python
if graph_required or (graph_preferred and include_preferred):
    channels.add("graph")
if quote_required:
    channels.update({"lexical", "vector"})
if numeric_required:
    channels.update({"lexical", "vector", "document_block"})
if table_required:
    channels.add("document_block")
if not channels:
    channels.update({"lexical", "vector"})   # 근거 없으면 원문 우선 hybrid가 기본값
```

`preferred` 채널은 `assurance_mode = "high_assurance"`일 때만 활성화되고 `fast` 모드에서는 생략된다. 순수 관계 조회(`graph_required`이고 quote/numeric/table이 전부 불필요)일 때만 graph가 유일한 채널이 될 수 있다 — 그 외에는 graph가 관계 후보를 찾아도 hybrid로 원문을 함께 확인한다.

### 4.1 질문 유형별 경로

| 질문 특징 | 주 경로 | 보조 경로 | 그래프의 역할 |
|---|---|---|---|
| 경영진이 원인을 어떻게 설명했는가 | hybrid (lexical + vector → RRF → rerank) | — | 사용 안 함 |
| 특정 수치·표의 값 | hybrid + document_block | — | 사용 안 함 |
| 기업/산업/정책의 다중 관계 | graph | graph가 찾은 문서의 hybrid 확장 | 관계 경로 탐색의 주 경로 |
| 정책이 산업을 거쳐 기업에 미친 경로 | graph + hybrid | — | graph 관계·시간 구조 + hybrid 원문 |
| 뉴스·공시의 사실 확인 | hybrid | — | 후보 관계 연결(선택적) |

### 4.2 RetrievalPolicy 예시

```json
{
  "policy_id": "rp_...",
  "channels": ["lexical", "vector"],
  "graph_mode": "off",
  "source_filters": ["filing", "earnings_transcript"],
  "date_filter": {"published_at_lte": "2026-08-07T10:00:00+09:00"},
  "fusion": "rrf",
  "embedding_model": "BAAI/bge-m3",
  "reranker": "BAAI/bge-reranker-v2-m3",
  "evidence_budget": 18,
  "retry_budget": 2,
  "assurance_mode": "high_assurance",
  "selected_by": "deterministic_policy_v2_two_clock"
}
```

`source_filters`는 질문 키워드(관세/정책/규제 → `government`, CFO/실적발표 → `filing`+`earnings_transcript` 등)로 결정되고, `evidence_budget`/`retry_budget`은 `fast` 모드에서 더 작게 설정된다.

### 4.3 두 개의 시계(clock)

`date_filter`는 발행 시점과 사업/이벤트 기간을 분리한다.

- `published_at_lte` — "이 시스템이 T 시점에 이 정보를 알 수 있었는가"를 답하는 가용성 커트라인. 항상 `as_of` 기준.
- `effective_at_gte/lte` — 질문이 요구하는 사업/이벤트 기간. 요청된 회계 기간을 `published_at_gte`로 쓰면 그 기간 이후에 제출된 원문 소스가 누락되므로 반드시 분리한다.
- 상대 표현(`relative_value`, 예: `last_4_quarters`)은 `relative_clock`(`publication`/`effective`/`best_available`)에 따라 뉴스는 발행 시점 기준, 실적/공시는 사업 기간 기준으로 다르게 해석한다.

---

## 5. 사용자 메모리는 이 단계에서 실행 여부만 결정된다

`QuerySpec.memory_mode`(`off`/`if_relevant`/…)는 Query Understanding Agent가 초안을 만들고, "메모리 사용하지 마"류의 명시적 요청이 질의에 있으면 검증 단계에서 `off`로 강제 전환한다(`memory_explicitly_disabled`). 실제 메모리 선택 로직은 [06_recovery_memory_and_harness.md](06_recovery_memory_and_harness.md)를 따른다.

---

## 6. Harness 관점의 검증 포인트

| 항목 | 의미 |
|------|------|
| `intent classification accuracy` | 질의 의도 분류가 맞는가 |
| `entity phrase extraction / resolution accuracy` | 핵심 기업/산업/정책 표현을 놓치지 않고 올바른 canonical ID로 확정했는가 |
| `temporal constraint extraction accuracy` | 명시/상대 시간 표현을 올바르게 파싱했는가, 근거 없이 기간을 만들지 않았는가 |
| `evidence_needs 판정 정확도` | LLM 초안과 코드 보정이 실제 질문 요구와 일치하는가 |
| `policy channel selection accuracy` | 선택된 채널이 필요한 근거 유형과 일치하는가 |

trace에는 최소 아래를 남긴다: raw/normalized query, `QuerySpec` 전체(JSON), `validation_notes`(승격/강등/제거 사유), 선택된 `RetrievalPolicy`.

대표 실패 유형: F1 엔티티 혼동, F2 시간축 오류, F8 과잉 방어(불필요한 clarification).

---

## 7. 설계 의사결정 근거

**왜 LLM structured output과 결정적 검증을 함께 쓰는가?**
"경영진이 원인을 어떻게 설명했는가", "표의 수치를 비교해 달라", "관계 경로를 보여 달라" 같은 질문은 단어 사전만으로 검색 채널을 안정적으로 정하기 어렵다. 반면 canonical entity, as_of, 채널 매핑은 재현성이 핵심이므로 코드가 담당한다. LLM의 자유 텍스트가 tool 호출을 직접 결정하지 않는 경계가 여기서 만들어진다.

**왜 `evidence_needs`는 boolean이 아니라 3단계인가?**
이진 값은 "필수"와 "있으면 좋음"을 구분하지 못해 예산이 부족할 때 우선순위를 매길 수 없다. `preferred`는 `fast`/`high_assurance` 모드에 따라 선택적으로 실행할 수 있는 여지를 준다.

**왜 발행 시점과 사업 기간을 분리하는가?**
"최근 4개 분기 매출"처럼 명시적 회계 기간이 있는 질문에서 발행 시점 필터만 쓰면 늦게 제출된 정정 공시가 누락되고, 반대로 사업 기간만 쓰면 아직 공시되지 않은 미래 정보가 새어 들어갈 위험이 있다.
