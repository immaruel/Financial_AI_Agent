# 03. 그래프 적재 파이프라인 (Graph Loader)

## 1. 목적

전처리 파이프라인의 최종 결과물(`ResolvedMention`, `CanonicalEvent`, `CanonicalDocument`)을 그래프 노드와 엣지로 변환하고, `InMemoryGraphStore`에 적재한다.

이 단계는 오프라인 파이프라인의 종착점이자, 에이전트가 탐색하는 KG의 실제 구조를 완성한다. `PassageIndex`를 함께 구축하여, 에이전트의 Evidence Retriever가 이벤트에서 원문 passage를 직접 조회할 수 있게 한다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `List[ResolvedMention]` | 전체 문서의 resolved entity mention |
| `List[CanonicalEvent]` | Event Canonicalization 결과 |
| `List[CanonicalDocument]` | 원본 문서 메타데이터 |
| `List[EventCandidate]` | (선택) Canonicalization 이전 후보 (PassageIndex 구성에 활용) |
| `Neo4jConfig` | 적재 설정 (배치 크기, PRECEDES 시간 윈도우) |
| `ReferenceDataManager` | 기업-산업 매핑 reference data |

### 출력

`GraphPayload`

```python
class GraphPayload:
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    passage_index: Optional[PassageIndex]
    seed_nodes: List[str]   # 신규 적재된 핵심 노드 ID
```

---

## 3. 처리 로직

`GraphPayloadBuilder.build()` 메서드가 아래 순서로 실행된다.

### 3.1 Company 노드 생성

`ResolvedMention` 중 `entity_type == "Company"` AND `resolution_status == "resolved"`인 항목을 Company 노드로 변환한다.

```python
node = GraphNode(
    node_id=mention.canonical_entity_id,
    label="Company",
    properties={
        "name": mention.canonical_name,
        "canonical_entity_id": mention.canonical_entity_id,
        # ReferenceDataManager에서 ticker, corp_code 등 추가
    }
)
```

### 3.2 Industry 노드 + BELONGS_TO_INDUSTRY 엣지 생성

`ReferenceDataManager`의 기업-산업 매핑 데이터를 기반으로 생성한다. 기사 문맥 추론은 사용하지 않는다.

```python
for company_id, industry_ids in ref_data.company_industry_map.items():
    for industry_id in industry_ids:
        edges.append(GraphEdge(
            source_id=company_id,
            target_id=industry_id,
            edge_type="BELONGS_TO_INDUSTRY",
            properties={"source": "reference_data", "confidence": 1.0}
        ))
```

### 3.3 Event 노드 + HAS_EVENT 엣지 생성

`CanonicalEvent`를 Event 노드로 변환하고, `subject_entity_id`와 연결하는 `HAS_EVENT` 엣지를 생성한다.

```python
event_node = GraphNode(
    node_id=event.canonical_event_id,
    label="Event",
    properties={
        "event_type": event.event_type,
        "event_time": _safe_iso(event.event_time),
        "polarity": _enum_value(event.polarity),
        "certainty": _enum_value(event.certainty),
        "confidence": event.confidence,
        "trigger_text": event.trigger_text,
        ...
    }
)

has_event_edge = GraphEdge(
    source_id=event.subject_entity_id,
    target_id=event.canonical_event_id,
    edge_type="HAS_EVENT",
    properties={"role": "subject", "confidence": event.confidence}
)
```

**HAS_EVENT 스킵 조건:**
- `subject_entity_id`가 None 또는 빈 문자열
- subject entity가 그래프에 존재하지 않음

### 3.4 INVOLVES 엣지 생성

`object_entity_id`가 존재하는 경우 Event → 대상 엔티티 연결.

```python
if event.object_entity_id:
    edges.append(GraphEdge(
        source_id=event.canonical_event_id,
        target_id=event.object_entity_id,
        edge_type="INVOLVES",
        properties={"role": "counterparty", "confidence": event.confidence}
    ))
```

### 3.5 Document 노드 생성

`CanonicalDocument`를 Document 노드로 변환한다.

### 3.6 Evidence 노드 + SUPPORTED_BY + FROM_DOCUMENT 엣지 생성

`CanonicalEvent.evidence`의 각 `EvidenceSpan`을 Evidence 노드로 변환하고, Event → Evidence → Document 체인을 구성한다.

```python
evidence_id = _build_passage_id(
    canonical_doc_id, sentence_id, char_start, char_end, text
)  # SHA-1 기반 결정적 ID 생성

evidence_node = GraphNode(node_id=evidence_id, label="Evidence", ...)
supported_by  = GraphEdge(source_id=event_id, target_id=evidence_id, edge_type="SUPPORTED_BY")
from_document = GraphEdge(source_id=evidence_id, target_id=doc_id, edge_type="FROM_DOCUMENT")
```

### 3.7 DISCLOSED_IN / REPORTED_IN 엣지 생성

```python
if source_type == "filing":
    edge_type = "DISCLOSED_IN"
elif source_type == "news":
    edge_type = "REPORTED_IN"
```

### 3.8 PRECEDES 엣지 생성

동일 Company의 Event 목록을 `event_time` 오름차순으로 정렬하고, 시간 차가 `precedes_max_lag_days(30일)` 이내인 연속 이벤트 쌍에 대해 엣지를 생성한다.

```python
for company_id, event_ids in company_event_map.items():
    sorted_events = sorted(event_ids, key=lambda e: events[e].event_time)
    for i in range(len(sorted_events) - 1):
        e1, e2 = sorted_events[i], sorted_events[i+1]
        lag = (events[e2].event_time - events[e1].event_time).days
        if lag <= config.precedes_max_lag_days:
            edges.append(GraphEdge(
                source_id=e1, target_id=e2,
                edge_type="PRECEDES",
                properties={"lag_days": lag}
            ))
```

### 3.9 PassageIndex 구축

모든 이벤트와 EventCandidate의 EvidenceSpan을 PassageIndex에 인덱싱한다.

```python
passage_index.event_to_passage_ids[event_id].append(passage_id)
passage_index.passages[passage_id] = PassageRecord(
    text=span.text,
    canonical_doc_id=span.canonical_doc_id,
    ...
)
```

PassageIndex의 구조 정의는 [03_knowledge_graph/02_graph_schema.md §4](02_graph_schema.md)를 참조한다. 이 PassageIndex를 실제로 조회하는 쪽은 [04_agent_system/04_evidence_retriever.md §3.2](../04_agent_system/04_evidence_retriever.md)이다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- `event_canonicalizer.py` → `CanonicalEvent`
- `entity_resolver.py` → `ResolvedMention`
- `document_fingerprint.py` → `CanonicalDocument`
- `reference/company_data.py` → 기업-산업 매핑

### Downstream
- `InMemoryGraphStore` → 적재된 노드/엣지 보관
- `agent/agents.py` → `GraphRetrieverAgent`가 `InMemoryGraphStore`를 탐색
- `main.py` → `save_graph()` / `load_graph()`로 JSON 직렬화

### 외부 의존성
- `Neo4jConfig` (config/settings.py): `precedes_max_lag_days=30`, `batch_size=500`

---

## 5. 데이터 흐름 내 위치

```
[Event Canonicalizer] + [Entity Resolver] + [CanonicalDocument]
              │
              ▼
[GraphPayloadBuilder.build()]   ← 이 문서
              │  GraphPayload
              ▼
[InMemoryGraphStore.load_payload()]
              │
              ├──→ nodes Dict 갱신
              ├──→ edges List 갱신
              └──→ passage_index 갱신
                         │
                         ▼
              [AgentOrchestrator] (STEP 4)
```

---

## 6. 구현 기준 설계

### 멱등성 보장 (MERGE 방식)

동일 `node_id`가 이미 존재하면 속성을 갱신하고, 없으면 신규 생성한다. `load_payload(payload, replace=False)` 호출 시 기존 그래프에 병합한다.

```python
def load_payload(self, payload: GraphPayload, replace: bool = False):
    if replace:
        self.nodes = {}
        self.edges = []
    for node in payload.nodes:
        self.nodes[node.node_id] = node   # 덮어쓰기로 MERGE 효과
    self.edges.extend(payload.edges)
```

### KG 저장 / 로드

```python
pipeline.save_graph(path)   # JSON 직렬화 → 파일 저장
pipeline.load_graph(path)   # 파일 로드 → InMemoryGraphStore 복원
```

STEP 1~3을 건너뛰고 에이전트 초기화(STEP 4)부터 재시작할 때 사용한다.

### 실시간 보완 병합

`main.py`의 `_online_supplement()`에서 `replace=False`로 호출하여 기존 KG에 신규 노드/엣지를 추가한다.

---

## 7. 설계 의사결정 근거

**왜 PassageIndex를 그래프 외부가 아닌 GraphPayload 내부에 포함하는가?**
PassageIndex는 에이전트가 이벤트 노드에서 원문 텍스트를 조회하는 핵심 인덱스다. GraphPayload에 포함하면 `save_graph()`/`load_graph()` 시 함께 직렬화되어, 재시작 후에도 원문 회수가 즉시 가능하다.

**왜 PRECEDES 엣지를 무차별로 생성하지 않는가?**
시간순으로 모든 이벤트 쌍을 연결하면 엣지 수가 O(N²)이 되어 탐색 비용이 증가한다. 동일 Company + 30일 이내 조건으로 제한하면, 실제 연쇄 가능성이 높은 이벤트만 연결되어 에이전트의 타임라인 탐색이 효율적이다.
