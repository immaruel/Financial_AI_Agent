# 05. Causal Reasoner Agent

## 1. 목적

`SubGraphResult`의 이벤트 노드와 `EvidenceResult`를 받아, 이벤트들을 **시간순·인과순으로 재구성**하여 `CausalChain`을 생성한다.

단순히 이벤트를 나열하는 것이 아니라, 이벤트 간 시간 선후 관계(`PRECEDES` 엣지)와 영향 관계(`CAUSES`, `AFFECTS` 엣지)를 반영하여 사건의 연쇄 흐름을 만든다.

하네스 엔지니어링 관점에서 Causal Reasoner는 **금융 AI 에이전트가 가장 쉽게 과장(overclaim)하는 지점**이므로, retrieval과 별도로 엄격하게 관찰해야 한다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `SubGraphResult` | 탐색된 노드(이벤트 포함) + 엣지 |
| `List[EvidenceResult]` | 각 이벤트의 원문 근거 |
| `AgentConfig` | 시간 제약 설정 |

### 출력

`CausalChain` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `events` | List[Dict] | 시간순 정렬된 이벤트 목록 |
| `causal_links` | List[Dict] | 인과 관계 목록 |
| `confidence_level` | str | observed / likely / hypothesis / confirmed |

`causal_links` 항목 구조:
```python
{
    "from_event_id": str,
    "to_event_id":   str,
    "link_type":     str,   # "PRECEDES" / "CAUSES" / "AFFECTS"
    "lag_days":      int,   # 시간 차 (일)
    "confidence":    float,
}
```

---

## 3. 처리 로직

### 3.1 이벤트 노드 수집

`SubGraphResult.nodes`에서 Event와 EventCandidate 노드를 분리 수집한다.

### 3.2 시간순 정렬

```python
sorted_events = sorted(
    event_nodes,
    key=lambda e: (e.get("event_time") or "", e.get("confidence", 0.0)),
    reverse=False  # 오래된 것부터
)
```

`event_time`이 없는 이벤트는 정렬 후위에 배치한다.

### 3.3 PRECEDES 엣지 탐색

SubGraphResult의 엣지에서 `edge_type == "PRECEDES"`인 것을 추출하여 `causal_links`로 변환한다.

```python
for edge in subgraph.edges:
    if edge["type"] == "PRECEDES":
        causal_links.append({
            "from_event_id": edge["source"],
            "to_event_id":   edge["target"],
            "link_type":     "PRECEDES",
            "lag_days":      edge.get("lag_days", 0),
            "confidence":    edge.get("confidence", 1.0),
        })
```

### 3.4 CAUSED_BY / AFFECTS 엣지 처리

더 강한 인과 근거가 있는 경우, `CAUSED_BY`와 `AFFECTS` 엣지를 `link_type = "CAUSES"` / `"AFFECTS"`로 변환한다.

### 3.5 confidence_level 결정

chain 내 이벤트들의 종합 신뢰도를 평가한다.

```python
avg_confidence = mean(e.get("confidence", 0) for e in events)

if avg_confidence >= 0.85 and all_confirmed:
    confidence_level = "confirmed"
elif avg_confidence >= 0.70:
    confidence_level = "observed"
elif avg_confidence >= 0.50:
    confidence_level = "likely"
else:
    confidence_level = "hypothesis"
```

`confirmed`: 공시 출처 이벤트가 과반수  
`observed`: 뉴스 출처 이벤트 위주이나 근거 있음  
`likely`: 일부 이벤트가 unverified  
`hypothesis`: 대부분 unverified 또는 낮은 confidence

---

## 4. 의존성 및 연계 모듈

### Upstream
- `GraphRetrieverAgent` → `SubGraphResult`
- `EvidenceRetrieverAgent` → `List[EvidenceResult]`

### Downstream
- `HypothesisCheckerAgent` → chain의 unsupported inference 점검
- `RiskControllerAgent` → `CausalChain.confidence_level` 및 개별 이벤트의 `certainty` 검증
- `AnswerComposerAgent` → `CausalChain.events`로 타임라인 구성

---

## 5. 데이터 흐름 내 위치

에이전트 파이프라인 **Step 4 / 7** — GraphRetriever와 EvidenceRetriever의 결과를 모두 받아 시간축·인과 체인으로 재구성한다.

```
[GraphRetrieverAgent] (Step 2)  +  [EvidenceRetrieverAgent] (Step 3)
        │  SubGraphResult + List[EvidenceResult]
        ▼
[CausalReasonerAgent]   ← 이 문서 (Step 4 / 7)
        │  CausalChain
        ├──→ [HypothesisCheckerAgent] (Step 5 / 7)
        ├──→ [AnswerComposerAgent]    (Step 6 / 7)
        └──→ [RiskControllerAgent]    (Step 7 / 7)
```

---

## 6. Harness 관점의 검증 포인트

Causal Reasoner는 아래 항목으로 검증한다.

| 항목 | 의미 |
|------|------|
| `temporal_order_consistency` | 이벤트 순서가 뒤집히지 않았는가 |
| `causal_chain_validity` | CAUSES / AFFECTS 링크가 그래프 근거와 일치하는가 |
| `unsupported_inference_rate` | evidence나 edge 없이 인과를 과장하지 않았는가 |
| `hedge_calibration_score` | 확정/가능성 서술 수위가 confidence와 맞는가 |

reasoning trace에는 아래를 남긴다.

- 정렬된 event sequence
- 사용된 PRECEDES / CAUSED_BY / AFFECTS edge
- rejected causal hypothesis
- chain-level confidence

대표 실패 유형:

- F2 시간축 오류
- F6 추론 과장
- F7 안전성 오류의 upstream 원인

---

## 7. 구현 기준 설계

### 인과 비약 방지

`PRECEDES` 엣지는 시간 선후 관계만을 나타낸다. 이를 인과 관계로 오해석하지 않도록, `causal_links`의 `link_type`을 명시적으로 구분한다.

- `PRECEDES`: 시간 선후만 확인됨 (인과 주장 없음)
- `CAUSES`: `CAUSED_BY` 엣지 존재 (인과 근거 있음)
- `AFFECTS`: `AFFECTS` 엣지 존재 (영향 근거 있음)

Answer Composer는 이 타입에 따라 서술 방식을 달리 한다.

---

## 8. 설계 의사결정 근거

**왜 인과 추론에 LLM을 사용하지 않는가?**
LLM이 임의로 인과 관계를 생성하면 확인되지 않은 인과 비약이 답변에 포함될 위험이 있다. 그래프에 존재하는 `CAUSED_BY`, `PRECEDES` 엣지만을 인과 관계의 근거로 사용함으로써, 답변의 모든 인과 주장이 실제 데이터에서 추출된 것임을 보장한다.

**왜 confidence_level을 4단계로 구분하는가?**
Risk Controller가 "확정과 가능성을 구분 강제"하는 규칙을 적용하려면 chain 수준의 신뢰도 평가가 필요하다. 단순 이진(신뢰/불신) 구분보다 4단계가 answer의 서술 수위를 더 세밀하게 조절할 수 있다.
