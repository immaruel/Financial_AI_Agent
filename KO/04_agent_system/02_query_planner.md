# 02. Query Planner Agent

## 1. 목적

사용자의 자연어 질의를 그래프 탐색이 가능한 구조화된 `QueryPlan`으로 변환한다.

질의 정규화, 시간 표현 파싱, 의도 분류, 엔티티 추출의 4단계로 구성된다. 모든 처리는 규칙 기반(정규식 + 사전)으로 수행하며 LLM을 사용하지 않는다.

하네스 엔지니어링 관점에서 Query Planner는 **온라인 파이프라인의 첫 번째 failure localization 지점**이다. 이후 Retrieval과 Reasoning 품질은 planner 출력의 품질에 크게 의존하므로, planner는 반드시 trace와 검증 메트릭의 대상이 된다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `query: str` | 사용자 자연어 질의 |
| `AgentConfig` | 의도 키워드 사전, 시간 표현 사전 |
| `entity_dict: Dict[str, str]` | `{기업명: canonical_entity_id}` (에이전트 초기화 시 ref_data에서 구축) |

### 출력

`QueryPlan` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `original_query` | str | 원본 질의 |
| `normalized_query` | str | 정규화된 질의 |
| `query_intents` | List[str] | 감지된 의도 목록 |
| `primary_intent` | str | 주 의도 |
| `secondary_intent` | str | 부 의도 |
| `time_constraints` | Dict | 시간 범위 (`from_date`, `to_date`, `window_days`) |
| `entity_phrases` | List[Dict] | 매칭된 엔티티 (`text`, `entity_id`, `source`) |
| `raw_phrases` | List[str] | 미매칭 명사 토큰 |

---

## 3. 처리 로직

### 3.1 질의 정규화

```python
def _normalize_query(self, query: str) -> str:
    q = query.strip()
    q = re.sub(r"\s+", " ", q)           # 연속 공백 정리
    q = re.sub(r"[?？!！]+$", "", q)     # 문장 종결 특수문자 제거
    q = re.sub(r"\(([^)]*)\)", r" \1 ", q)  # 괄호 표현 펼치기
    q = re.sub(r"[~\-–—]+", " ", q)     # 대시류 공백 처리
    return q.strip()
```

조사는 제거하지 않는다. 조사 제거는 한국어 문법 분석기가 없으면 오히려 명사 경계를 망가뜨릴 수 있다.

### 3.2 시간 표현 추출

`AgentConfig.temporal_expressions` 사전에서 질의 내 시간 표현을 탐색한다.

| 표현 | window_days |
|------|-------------|
| 오늘 | 0 |
| 어제 | 1 |
| 이번 주 | 7 |
| 최근 | 30 |
| 최근 3개월 | 90 |
| 올해 | 365 |

```python
for expr, days in self.config.temporal_expressions.items():
    if expr in text:
        constraints = {
            "expression": expr,
            "from_date": (now - timedelta(days=days)).isoformat(),
            "to_date": now.isoformat(),
            "window_days": days,
        }
        break
```

시간 표현이 없으면 기본 30일 윈도우를 적용한다. 연도·월 패턴(`2024년`, `3월`)은 별도 정규식으로 추출하여 `constraints["year"]`, `constraints["month"]`에 저장한다.

### 3.3 질의 의도 분류

```python
query_intent_keywords = {
    "fact_lookup":        ["무엇", "얼마", "어떤", "언제", "누가"],
    "impact_analysis":    ["영향", "수혜", "피해", "미친", "파급", "효과"],
    "timeline_summary":   ["정리", "흐름", "타임라인", "순서", "경과"],
    "company_screening":  ["종목", "기업", "회사", "스크리닝", "필터"],
    "event_summary":      ["최근", "무슨 일", "어떤 이벤트", "사건"],
    "comparison":         ["비교", "차이", "대비", "vs"],
    "policy_tracking":    ["정책", "규제", "법안", "제도"],
}
```

하나의 질의가 여러 의도를 가질 수 있으므로 `primary_intent` + `secondary_intent` 구조로 관리한다.

### 3.4 엔티티 추출

두 단계로 수행된다.

**Step 1: entity_dict 기반 매칭**

긴 이름을 먼저 매칭(길이 내림차순 정렬)하여 포함 관계로 인한 중복 매칭을 방지한다.

```python
for name, eid in sorted(entity_dict.items(), key=lambda x: len(x[0]), reverse=True):
    if name in text and eid not in seen_entity_ids:
        entity_phrases.append({"text": name, "entity_id": eid, "source": "dict"})
        seen_entity_ids.add(eid)
```

**Step 2: raw_phrases 추출 (미매칭 명사 토큰)**

entity_dict에서 매칭되지 않은 한글·영문 토큰을 추출한다. 조사 패턴을 제거하고 stopwords를 필터링한다.

```python
stopwords = {
    "최근", "최신", "무슨", "알려줘", "정리", "요약", "관련", "뉴스", "동향", ...
}
particle_pattern = re.compile(
    r"(으로부터|으로는|에서는|에게|으로|까지|부터|은|는|이|가|을|를|와|과|도|에|의)$"
)
```

`raw_phrases`는 Graph Retriever의 seed node 탐색에서 부분 문자열 매칭 및 fuzzy 매칭에 사용된다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- 사용자 입력 (str)
- `AgentConfig` (config/settings.py)
- `entity_dict` → `ReferenceDataManager`에서 `step4_init_agents()` 시 구축

### Downstream
- `GraphRetrieverAgent.retrieve(plan)` → QueryPlan 전달

---

## 5. 데이터 흐름 내 위치

에이전트 파이프라인 **Step 1 / 7** — 유일한 입력은 사용자 자연어 문자열이며, 이후 모든 에이전트가 이 QueryPlan을 공통 컨텍스트로 사용한다.

```
사용자 질의
        │
        ▼
[QueryPlannerAgent]   ← 이 문서 (Step 1 / 7)
        │  QueryPlan
        ▼
[GraphRetrieverAgent]  (Step 2 / 7)
```

---

## 6. Harness 관점의 검증 포인트

Query Planner는 아래 항목을 기준으로 검증한다.

| 항목 | 의미 |
|------|------|
| `intent classification accuracy` | 질의 의도 분류가 맞는가 |
| `entity phrase extraction accuracy` | 핵심 기업/산업/정책 표현을 놓치지 않았는가 |
| `temporal constraint extraction accuracy` | 최근/올해/최근 3개월 같은 시간 범위를 올바르게 파싱했는가 |
| `query decomposition quality` | 복합 질의를 primary / secondary intent로 적절히 분해했는가 |

planner trace에는 최소 아래를 남기는 것이 좋다.

- raw query
- normalized query
- query_intents
- primary / secondary intent
- extracted entities
- temporal constraints
- low-confidence parsing flag

대표 실패 유형:

- F1 엔티티 혼동
- F2 시간축 오류
- F8 과잉 방어 또는 지나친 축약

---

## 7. 구현 기준 설계

### entity_dict 구축 (step4_init_agents에서 1회 실행)

```python
entity_dict = {}
for comp in self.ref_data.companies.values():
    entity_dict[comp.name] = comp.canonical_entity_id
    for alias in comp.aliases:
        entity_dict[alias] = comp.canonical_entity_id

self.agent_orchestrator = AgentOrchestrator(
    config=self.config.agent,
    graph_store=self.graph_store,
    llm_client=self.llm_client,
    entity_dict=entity_dict,
)
```

KG Miss로 실시간 보완 수집 후 `step4_init_agents()`를 재호출하면 entity_dict도 갱신된다.

---

## 8. 설계 의사결정 근거

**왜 LLM으로 질의를 파싱하지 않는가?**
질의 파싱에 LLM을 사용하면 응답 지연이 증가하고 결과가 비결정적이 된다. 금융 질의의 핵심 패턴(시간 표현, 기업명, 의도 키워드)은 사전과 정규식으로 충분히 커버된다. LLM은 답변 생성(Answer Composer)에 집중 투입한다.

**왜 primary + secondary 이중 의도 구조를 사용하는가?**
"현대차 최근 실적을 경쟁사와 비교해줘"는 `event_summary`(primary)와 `comparison`(secondary)를 동시에 가진다. 단일 의도만 허용하면 이런 복합 질의에서 Graph Retriever의 hop 수와 edge type 선택이 불완전해진다.
