# 06. Risk Controller & Answer Composer Agent

> **구현 정합성 메모**: 현재 구현에서는 `HypothesisCheckerAgent`와 `RiskControllerAgent`가 별도 클래스로 존재한다. `HypothesisCheckerAgent`는 그래프 근거 기반 주장 검증을 담당하고, `RiskControllerAgent`는 최종 답변의 투자 표현·과도한 확신·경고 메시지를 후처리한다. 이 문서는 두 역할을 구분하되, 최종 사용자 안전성 관점에서 함께 설명한다.

---

## Part 1: Risk Controller Agent

### 1. 목적

Answer Composer가 생성한 답변 초안에 대해 아래 두 가지 위험 요소를 검증하고 경고 목록(`risk_warnings`)을 생성한다.

- **Hypothesis 검증 연계**: 생성된 답변 초안이 실제 그래프 근거에 기반하는지 `HypothesisCheckerAgent`의 verdict와 함께 해석. 시간 순서, 인과 비약, 상충 근거, 루머-공시 혼동 여부를 반영.
- **Risk 필터 (Risk Controller 역할)**: 투자 추천·수익 보장 등의 표현이 최종 답변에 포함되지 않도록 제어하는 마지막 안전장치.

---

### 2. 입력 / 출력

**입력:**

| 항목 | 설명 |
|------|------|
| `StructuredAnswer` 초안 | Answer Composer가 만든 초안 |
| `HypothesisChecker` verdict | unsupported claim / contradiction 검증 결과 |
| `AgentConfig.prohibited_phrases` | 금지 문구 사전 |

**출력:**

수정된 `StructuredAnswer` — `risk_warnings`가 채워지고 위험 문구가 정제된 최종 출력

---

### 3. 처리 로직

아래 5개 항목을 순차 검증한다.

#### 3.1 투자 추천 문구 탐지

```python
prohibited_phrases = [
    "반드시 오를", "확실한 수익", "투자하세요", "매수 추천",
    "매도 추천", "수익 보장", "손실 없는",
]
```

이 패턴이 생성된 텍스트에 포함되면 해당 문장을 제거하고 경고를 추가한다.

#### 3.2 확정/가능성 혼동 탐지

이벤트의 `certainty` 속성을 검사한다.

```
certainty == "speculated" AND 답변에 확정형 서술 → 경고 추가
certainty == "disclosed"  AND 답변에 추정형 서술  → 경고 추가
```

#### 3.3 최신성 부족 경고

`time_constraints["window_days"]` 기준으로 이벤트의 `event_time`이 요청 기간을 벗어난 경우.

```python
if chain.events:
    latest_time = max(e.get("event_time") for e in chain.events if e.get("event_time"))
    if (now - datetime.fromisoformat(latest_time)).days > window_days * 1.5:
        warnings.append("수집된 이벤트가 요청 기간보다 오래되었습니다. 최신 정보를 확인하세요.")
```

#### 3.4 상충 근거 존재 시 양측 제시 강제

Evidence Retriever가 감지한 `conflicts`가 존재하는 경우.

```python
for ev_result in evidence_results:
    if ev_result.conflicts:
        warnings.append(
            f"이벤트 {ev_result.event_id}에 대해 상충하는 근거가 존재합니다: "
            + "; ".join(ev_result.conflicts)
        )
```

#### 3.5 근거 없는 인과 비약 탐지

`HypothesisCheckerAgent`가 unsupported inference 또는 contradiction을 보고한 상태에서 답변이 확정적 인과 표현을 유지하면 경고를 추가한다.

---

### 4. 설계 의사결정 근거

**왜 후처리 필터가 필요한가?**
Answer Composer 내부에 모든 안전 규칙을 넣으면 생성 로직과 검증 로직이 얽혀 규칙 추가·수정이 어려워진다. 후처리 필터로 분리하면 금지 문구 목록, low-confidence 정책, 위험 경고를 독립적으로 관리할 수 있다.

---

## Part 2: Answer Composer Agent

### 1. 목적

QueryPlan, SubGraphResult, EvidenceResult, CausalChain, risk_warnings를 통합하여 구조화된 최종 답변(`StructuredAnswer`)을 생성한다.

이 단계가 에이전트 파이프라인에서 **LLM(Qwen)이 유일하게 호출되는 지점**이다.

---

### 2. 입력 / 출력

**입력:**

| 항목 | 설명 |
|------|------|
| `QueryPlan` | 원본 질의, 의도, 시간 제약 |
| `SubGraphResult` | 탐색된 노드/엣지 |
| `List[EvidenceResult]` | 원문 근거 |
| `CausalChain` | 시간순 이벤트 체인 |
| `List[str]` | risk_warnings |
| `QwenLLMClient` | 답변 생성 LLM |

**출력:**

`StructuredAnswer` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `summary` | str | 핵심 요약 (1~3문장) |
| `timeline` | List[Dict] | 주요 이벤트 타임라인 |
| `related_companies` | List[str] | 관련 기업 목록 |
| `impact_analysis` | str | 수혜/피해 논리 서술 |
| `counter_evidence` | str | 반대 근거 또는 상충 정보 |
| `confidence` | float | 전체 답변 confidence |
| `sources` | List[Dict] | 원문 근거 출처 목록 |
| `risk_warnings` | List[str] | Risk Controller 경고 목록 |

---

### 3. 처리 로직

#### 3.1 LLM 프롬프트 구성

```
[System Prompt]
너는 금융 뉴스와 공시 데이터를 분석하는 전문가다.
주어진 그래프 데이터와 근거 문서를 기반으로 사실에 입각한 답변을 생성하라.
투자 추천이나 수익 보장 표현은 절대 사용하지 마라.

[User Prompt]
질의: {original_query}

[관련 이벤트]
{causal_chain.events를 시간순으로 포맷팅}

[근거 문서]
{evidence_results에서 상위 N개 passage 포함}

[관련 기업]
{seed_nodes 기반 company 목록}

위 정보를 바탕으로 아래 형식으로 답변하라:
- 핵심 요약
- 이벤트 타임라인
- 영향 분석
- 근거 불충분한 부분 명시
```

#### 3.2 타임라인 구성

LLM 생성 없이 규칙 기반으로 구성한다.

```python
timeline = [
    {
        "date": event.get("event_time", ""),
        "event_type": event.get("event_type", ""),
        "description": event.get("trigger_text", ""),
        "company": event.get("subject_entity_id", ""),
        "certainty": event.get("certainty", ""),
        "sources": [ev for ev in sources if ev["event_id"] == event["id"]],
    }
    for event in causal_chain.events
]
```

#### 3.3 관련 기업 추출

SubGraphResult의 Company 노드에서 추출.

```python
related_companies = [
    node["name"]
    for node in subgraph.nodes
    if node.get("label") == "Company"
]
```

#### 3.4 confidence 계산

```python
confidence = (
    causal_chain_avg_confidence * 0.6 +
    evidence_coverage_ratio * 0.4  # 이벤트 중 evidence 있는 비율
)
```

---

### 4. 설계 의사결정 근거

**왜 타임라인은 LLM이 아닌 규칙 기반으로 구성하는가?**
타임라인은 그래프에서 이미 시간순 정렬된 이벤트 목록이 있으므로 LLM이 개입하면 순서가 바뀌거나 존재하지 않는 이벤트가 포함될 위험이 있다. 규칙 기반 구성으로 타임라인의 정확성을 보장하고, LLM은 서술형 텍스트(summary, impact_analysis) 생성에만 집중시킨다.

**왜 sources를 별도 필드로 유지하는가?**
금융 도메인에서 모든 주장은 출처를 명시해야 한다. `sources` 필드를 구조화된 형태로 유지하면, 사용자 인터페이스에서 "이 정보는 [공시명] 문서에서 확인됨" 형태의 링크를 제공할 수 있다.
