# 03. Graph Retriever Agent

## 1. 목적

`QueryPlan`을 받아 KG에서 관련 subgraph를 탐색하고 `SubGraphResult`를 반환한다. Seed 노드 탐색 → 의도별 hop 결정 → BFS 기반 subgraph 확장 → 시간 필터링 → 크기 제한의 순서로 처리한다.

이 모듈의 출력이 LLM의 input context(그래프 부분)를 구성하는 핵심 소재다.

하네스 엔지니어링 관점에서 Graph Retriever는 **"필요한 그래프를 못 가져왔는가, 아니면 가져왔는데 이후 단계가 못 썼는가"를 가르는 핵심 경계**다. 따라서 retrieval 품질은 reasoning 품질과 분리해서 평가해야 한다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `QueryPlan` | 질의 의도, 엔티티 구문, 시간 제약 |
| `InMemoryGraphStore` | 탐색 대상 KG |
| `AgentConfig` | hop 설정, subgraph 최대 크기, edge confidence 임계값 |

### 출력

`SubGraphResult` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `seed_nodes` | List[str] | 탐색 시작점 노드 ID 목록 |
| `nodes` | List[Dict] | 탐색된 노드 (속성 포함) |
| `edges` | List[Dict] | 탐색된 엣지 |
| `hop_depth` | int | 실제 탐색 hop 수 |
| `retrieval_method` | str | "hybrid" |

---

## 3. 처리 로직

### 3.1 Seed 노드 탐색

3단계 fallback 전략으로 seed 노드를 탐색한다.

```
Step 1: entity_phrases 직접 매칭 (entity_dict 기반)
  → plan.entity_phrases의 entity_id가 그래프에 존재하면 즉시 사용

Step 2: raw_phrases 부분 문자열 매칭
  → node.properties["name"]에 phrase 포함 또는 반대
  → 모든 그래프 노드를 순회하므로 비용이 있음

Step 3: Fuzzy 매칭 (Step 1, 2에서 seed를 찾지 못한 경우에만 실행)
  → rapidfuzz.fuzz.partial_ratio(phrase, node_name) >= 80
  → 매칭 시 로그 기록
```

```python
if not seed_ids:
    from rapidfuzz import fuzz
    for phrase in all_phrases:
        for node in self.graph.nodes.values():
            score = fuzz.partial_ratio(phrase, node.properties.get("name", ""))
            if score >= 80:
                seed_ids.append(node.node_id)
```

### 3.2 의도별 hop 수 결정

```python
hop_by_intent = {
    "event_summary":   2,
    "fact_lookup":     2,
    "impact_analysis": 3,
    "comparison":      2,
}
max_hops = hop_by_intent.get(plan.primary_intent, 2)
```

### 3.3 의도별 허용 엣지 타입

그래프 탐색 시 이 목록에 포함된 엣지 타입만 따라간다.

| 의도 | 허용 엣지 |
|------|-----------|
| `event_summary` | HAS_EVENT, HAS_EVENT_CANDIDATE, CANONICALIZED_TO, SUPPORTED_BY, FROM_DOCUMENT, DISCLOSED_IN, REPORTED_IN, OBSERVED_IN, PRECEDES |
| `impact_analysis` | HAS_EVENT, HAS_EVENT_CANDIDATE, INVOLVES, AFFECTS, CAUSED_BY, PRECEDES, SUPPORTED_BY, FROM_DOCUMENT |
| `fact_lookup` | HAS_EVENT, HAS_EVENT_CANDIDATE, SUPPORTED_BY, FROM_DOCUMENT, DISCLOSED_IN, REPORTED_IN, OBSERVED_IN |
| `company_screening` | BELONGS_TO_INDUSTRY, HAS_EVENT, HAS_EVENT_CANDIDATE |
| 기본 | HAS_EVENT, HAS_EVENT_CANDIDATE, CANONICALIZED_TO, SUPPORTED_BY, FROM_DOCUMENT |

### 3.4 BFS 기반 Subgraph 탐색

`InMemoryGraphStore.get_subgraph()` 메서드 호출.

```python
subgraph = self.graph.get_subgraph(
    seed_ids=seed_ids,
    max_hops=max_hops,
    min_confidence=self.config.min_edge_confidence,  # 기본값: 0.60
    edge_types=edge_types,
)
```

`min_edge_confidence`는 낮은 confidence의 엣지를 탐색 경로에서 제외한다.

### 3.5 시간 필터링

`time_constraints["window_days"]`가 설정된 경우, Event 노드의 `event_time`을 기준으로 윈도우 외부 이벤트를 제거한다.

```python
cutoff = datetime.now(KST) - timedelta(days=window_days)
filtered_nodes = [
    node for node in subgraph.nodes
    if node.label != "Event" or (
        node.properties.get("event_time") and
        datetime.fromisoformat(node.properties["event_time"]) >= cutoff
    )
]
```

필터링 후 고립된 엣지(양쪽 노드가 모두 존재하지 않는 엣지)는 함께 제거한다.

### 3.6 Subgraph 크기 제한

노드 수가 `max_subgraph_nodes(50)`를 초과하면 **relevance 점수 기반 truncation**을 수행한다 (`_truncate_subgraph_safe()`).

**노드별 relevance 점수 산정:**

| 노드 유형 | 기본 점수 | 설명 |
|-----------|-----------|------|
| Seed Node | 10점 | entity_dict에서 직접 매칭된 기업/엔티티 노드 |
| Primary Event | 7점 | Seed Node에 직접 연결된 HAS_EVENT 대상 |
| 1-hop Node | 4점 | Seed에서 1단계 탐색으로 도달한 노드 |
| 2-hop 이상 Node | 2점 | 그 이상 거리의 노드 |

confidence 속성이 있는 엣지의 경우 `base_score × confidence`로 최종 점수를 산정한다. 점수 상위 50개 노드만 유지하고, 나머지 노드와 연결된 엣지는 함께 제거한다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- `QueryPlannerAgent` → `QueryPlan`
- `InMemoryGraphStore` (ontology/graph_loader.py)
- `AgentConfig` (config/settings.py)

### Downstream
- `EvidenceRetrieverAgent` → `SubGraphResult` 전달
- `CausalReasonerAgent` → `SubGraphResult` 전달
- `AnswerComposerAgent` → `SubGraphResult` 전달 (LLM context 구성에 사용)

### 외부 의존성
- `rapidfuzz`: fuzzy seed 탐색

---

## 5. 데이터 흐름 내 위치

에이전트 파이프라인 **Step 2 / 7** — QueryPlan을 받아 KG를 탐색하고, 결과 SubGraphResult를 하위 에이전트들에 공통 전달한다.

```
[QueryPlannerAgent]  (Step 1 / 7)
        │  QueryPlan
        ▼
[GraphRetrieverAgent]   ← 이 문서 (Step 2 / 7)
        │  SubGraphResult
        ├──→ [EvidenceRetrieverAgent]
        ├──→ [CausalReasonerAgent]
        └──→ [AnswerComposerAgent]
```

---

## 6. Harness 관점의 검증 포인트

Graph Retriever는 아래 항목을 별도로 측정하는 것이 좋다.

| 항목 | 의미 |
|------|------|
| `seed_precision` / `seed_recall` | planner가 준 entity/raw phrase로 올바른 시작 노드를 찾았는가 |
| `subgraph_recall@k` | 정답에 필요한 핵심 이벤트/기업/문서를 포함했는가 |
| `irrelevant_node_ratio` | 잡음 노드를 과도하게 포함하지 않았는가 |
| `temporal_filter_accuracy` | 시간 조건이 있는 질의에서 너무 오래된 이벤트를 잘 걸렀는가 |
| `edge-type coverage` | 질의 의도에 필요한 edge type을 빠뜨리지 않았는가 |

retrieval trace에는 아래 정보를 남긴다.

- seed node ids
- seed 탐색 방식(exact / partial / fuzzy)
- hop 수
- 허용 edge type 목록
- pruning 이전·이후 노드 수
- temporal filter 적용 결과

대표 실패 유형:

- F1 엔티티 혼동
- F2 시간축 오류
- F5 근거 누락의 upstream 원인

---

## 7. 구현 기준 설계

### `get_subgraph` 내부 동작

```python
def get_subgraph(self, seed_ids, max_hops, min_confidence, edge_types):
    visited = set(seed_ids)
    frontier = set(seed_ids)

    for hop in range(max_hops):
        next_frontier = set()
        for edge in self.edges:
            if edge.edge_type not in edge_types:
                continue
            conf = edge.properties.get("confidence", 1.0)
            if conf < min_confidence:
                continue
            if edge.source_id in frontier and edge.target_id not in visited:
                next_frontier.add(edge.target_id)
                visited.add(edge.target_id)
        frontier = next_frontier

    result_nodes = [self.nodes[nid] for nid in visited if nid in self.nodes]
    result_edges = [
        e for e in self.edges
        if e.source_id in visited and e.target_id in visited
        and e.edge_type in edge_types
    ]
    return GraphPayload(nodes=result_nodes, edges=result_edges)
```

### SubGraphResult 노드 구조

`SubGraphResult.nodes`의 각 항목은 `{"id": node_id, "label": label, **properties}` 형태로 평탄화되어, AnswerComposer가 LLM 프롬프트를 구성하기 쉽도록 한다.

---

## 8. 설계 의사결정 근거

**왜 의도별로 허용 엣지 타입을 다르게 하는가?**
`event_summary` 질의에서 `CAUSED_BY` 엣지를 따라가면 원하지 않는 인과 체인이 포함된다. 반면 `impact_analysis` 질의에서는 `CAUSED_BY`와 `AFFECTS`가 핵심이다. 의도별 엣지 필터링은 subgraph의 노이즈를 줄이고 LLM context의 관련성을 높인다.

**왜 Fuzzy 매칭을 마지막 fallback으로 두는가?**
Fuzzy 매칭은 모든 그래프 노드를 순회하므로 노드 수에 비례한 비용이 발생한다. Exact Match와 부분 문자열 매칭이 충분히 높은 커버리지를 제공하므로, Fuzzy는 두 방법이 모두 실패했을 때만 실행한다.
