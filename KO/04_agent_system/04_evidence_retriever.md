# 04. Evidence Retriever Agent

## 1. 목적

Graph Retriever가 탐색한 `SubGraphResult`의 Event 노드에 대해 **원문 근거(passage)를 회수**한다.

그래프 노드에는 이벤트의 구조화된 정보가 저장되지만, 원문 텍스트는 `PassageIndex`에 별도로 인덱싱되어 있다. 이 모듈은 두 저장소를 연결하여 에이전트가 "그래프에서 찾은 사실을 원문에서 직접 확인"할 수 있게 한다. 이를 통해 답변의 신뢰도를 높이고 출처를 명시할 수 있다.

하네스 엔지니어링 관점에서 Evidence Retriever는 **"답변이 근거 부족인지, retrieval은 됐지만 citation이 약한 것인지"를 분해하는 핵심 모듈**이다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `SubGraphResult` | GraphRetriever의 탐색 결과 |
| `InMemoryGraphStore` (PassageIndex 포함) | 원문 passage 저장소 |

### 출력

`List[EvidenceResult]`

`EvidenceResult` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `event_id` | str | 근거를 조회한 이벤트 ID |
| `evidences` | List[Dict] | 원문 근거 목록 |
| `verification_status` | str | confirmed / partial / unverified |
| `conflicts` | List[str] | 상충하는 근거 설명 |

`evidences` 항목 구조:

```python
{
    "passage_id": str,
    "text": str,          # 원문 텍스트
    "source_url": str,    # 출처 URL
    "title": str,         # 문서 제목
    "source_type": str,   # filing / news
    "published_at": str,  # 게시 시각
}
```

---

## 3. 처리 로직

### 3.1 Event 노드 식별

`SubGraphResult.nodes`에서 `label == "Event"` 또는 `label == "EventCandidate"`인 노드를 추출한다.

### 3.2 PassageIndex 조회

```python
for event_node in event_nodes:
    event_id = event_node["id"]

    # CanonicalEvent용 인덱스
    passage_ids = graph_store.passage_index.event_to_passage_ids.get(event_id, [])

    # EventCandidate용 인덱스 (없으면 SUPPORTED_BY 엣지 탐색으로 fallback)
    if not passage_ids:
        passage_ids = graph_store.passage_index.event_candidate_to_passage_ids.get(event_id, [])
```

### 3.3 원문 텍스트 조회

```python
for passage_id in passage_ids:
    record = graph_store.passage_index.passages.get(passage_id)
    if record:
        doc_record = graph_store.passage_index.documents.get(record.canonical_doc_id)
        evidence = {
            "passage_id": passage_id,
            "text": record.text,
            "source_url": doc_record.source_url if doc_record else "",
            "title": doc_record.title if doc_record else "",
            "source_type": doc_record.source_type if doc_record else "",
            "published_at": doc_record.published_at if doc_record else None,
        }
```

### 3.4 상충 근거 탐지

동일 이벤트에 연결된 근거들 간에 상충 내용이 있는지 확인한다.

```python
conflicts = []
for i, ev_a in enumerate(evidences):
    for ev_b in evidences[i+1:]:
        if _is_conflicting(ev_a["text"], ev_b["text"]):
            conflicts.append(f"'{ev_a['title']}' vs '{ev_b['title']}'")
```

상충 판정 기준: 동일 이벤트에 대해 `source_type == "filing"`과 `source_type == "news"`의 내용이 금액·시점 등 핵심 속성에서 다를 경우.

### 3.5 verification_status 결정

```python
if any(ev["source_type"] == "filing" for ev in evidences):
    verification_status = "confirmed"
elif evidences:
    verification_status = "partial"
else:
    verification_status = "unverified"
```

---

## 4. 의존성 및 연계 모듈

### Upstream
- `GraphRetrieverAgent` → `SubGraphResult`
- `InMemoryGraphStore.passage_index` → `PassageIndex`

### Downstream
- `CausalReasonerAgent` → `EvidenceResult` 리스트 활용
- `HypothesisCheckerAgent` → contradiction / unsupported claim 검증 입력
- `AnswerComposerAgent` → `sources` 필드 구성에 활용
- `RiskControllerAgent` → 상충 근거 존재 시 경고 추가

---

## 5. 데이터 흐름 내 위치

에이전트 파이프라인 **Step 3 / 7** — SubGraphResult의 Event 노드 ID를 키로 PassageIndex를 조회하여 원문 근거를 회수한다.

```
[GraphRetrieverAgent]  (Step 2 / 7)
        │  SubGraphResult
        ▼
[EvidenceRetrieverAgent]   ← 이 문서 (Step 3 / 7)
        │  List[EvidenceResult]
        ├──→ [CausalReasonerAgent]   (Step 4 / 7)
        ├──→ [HypothesisCheckerAgent] (Step 5 / 7)
        └──→ [AnswerComposerAgent]   (Step 6 / 7)
```

---

## 6. Harness 관점의 검증 포인트

Evidence Retriever는 아래 메트릭으로 검증하는 것이 좋다.

| 항목 | 의미 |
|------|------|
| `evidence_recall@k` | 답변에 필요한 핵심 원문을 회수했는가 |
| `evidence_precision@k` | 회수한 근거가 실제로 관련 있는가 |
| `citation_coverage` | 핵심 주장에 citation이 붙는가 |
| `contradiction_recall` | 반대/상충 근거를 놓치지 않았는가 |
| `verification_status distribution` | confirmed / partial / unverified 비율이 적절한가 |

evidence trace에는 아래 정보를 남긴다.

- event_id별 selected evidence ids
- ranking score 또는 선택 근거
- filing/news source 분포
- contradiction evidence 포함 여부

대표 실패 유형:

- F5 근거 누락
- F2 시간축 오류의 downstream 증상
- F6 추론 과장의 upstream 원인

---

## 7. 구현 기준 설계

### PassageIndex와 그래프의 연결

PassageIndex는 [03_knowledge_graph/03_graph_loader.md §3.9](../03_knowledge_graph/03_graph_loader.md)에서 구축된다. `GraphPayloadBuilder.build()`에서 PassageIndex가 함께 구축되어 `GraphPayload.passage_index`에 포함된다. `InMemoryGraphStore.load_payload()`는 이 PassageIndex를 `self.passage_index`에 저장한다.

```
CanonicalEvent.evidence (EvidenceSpan)
        │
        ▼  (GraphPayloadBuilder에서 인덱싱)
PassageIndex.event_to_passage_ids[event_id] = [passage_id, ...]
PassageIndex.passages[passage_id] = PassageRecord(text=..., canonical_doc_id=...)
PassageIndex.documents[canonical_doc_id] = DocumentTextRecord(title=..., source_url=...)
```

### 근거 없는 이벤트 처리

PassageIndex에 passage가 없는 이벤트는 `verification_status = "unverified"`로 표시되고, Answer Composer가 해당 이벤트에 대해 출처 불명 경고를 추가한다.

---

## 8. 설계 의사결정 근거

**왜 그래프 엣지가 아닌 PassageIndex로 원문을 회수하는가?**
그래프 탐색(`SUPPORTED_BY → FROM_DOCUMENT` 경로)으로 원문을 조회하면 매번 엣지를 순회하는 비용이 발생한다. PassageIndex는 event_id → passage_id 목록을 O(1) 조회로 제공한다. 대신 그래프 엣지(SUPPORTED_BY, FROM_DOCUMENT)는 그래프 구조 탐색 목적으로 유지한다.

**왜 상충 근거를 탐지하는가?**
금융 이벤트는 뉴스와 공시가 서로 다른 수치나 일정을 보도하는 경우가 있다. Risk Controller가 "서로 상충하는 뉴스/공시가 있는가"를 검증하려면 이 단계에서 상충 정보가 감지되어야 한다. 상충 여부는 `StructuredAnswer.counter_evidence` 필드에 포함된다.
