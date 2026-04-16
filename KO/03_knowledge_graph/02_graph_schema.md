# 02. 그래프 스키마 (Graph Schema)

## 1. 목적

온톨로지 정의를 실제 Neo4j(및 InMemoryGraphStore) 구조로 구체화한다. 노드·엣지별 필수 속성, unique key, 적재 조건, 스킵 조건을 명세한다.

---

## 2. 노드 스키마

### Company

```
Label:      Company
Unique Key: canonical_entity_id
```

| 속성 | 필수 | 타입 | 설명 |
|------|------|------|------|
| `canonical_entity_id` | ✓ | str | 전체 시스템 고유 키 |
| `name` | ✓ | str | 공식 기업명 |
| `ticker` | | str | 종목코드 |
| `corp_code` | | str | DART 법인코드 |
| `exchange` | | str | 상장 거래소 |
| `country` | | str | 소재 국가 |
| `status` | | str | active / delisted |
| `created_at` | | datetime | 노드 최초 생성 시각 |
| `updated_at` | | datetime | 최종 갱신 시각 |

**적재 조건:**
- `entity_type == "Company"` AND `canonical_entity_id` 존재
- reference data 또는 alias resolution으로 정규화 완료

**스킵 조건:**
- unresolved mention (`resolution_status != "resolved"`)
- generic placeholder company

**갱신 방식:** `canonical_entity_id` 기준 MERGE, 최신값으로 SET

---

### Industry

```
Label:      Industry
Unique Key: industry_id
```

| 속성 | 필수 | 타입 | 설명 |
|------|------|------|------|
| `industry_id` | ✓ | str | 산업 분류 ID |
| `name` | ✓ | str | 산업명 |
| `taxonomy_source` | | str | 분류 기준 출처 |
| `status` | | str | |
| `created_at` | | datetime | |
| `updated_at` | | datetime | |

**적재 조건:** reference data 기반 매핑 존재 시
**스킵 조건:** 기사 단일 문맥만으로 추정된 산업

---

### Event

```
Label:      Event
Unique Key: canonical_event_id
```

| 속성 | 필수 | 타입 | 설명 |
|------|------|------|------|
| `canonical_event_id` | ✓ | str | 이벤트 고유 키 |
| `event_type` | ✓ | str | leaf 이벤트 타입 |
| `event_time` | ✓ | datetime | 발생 시각 |
| `event_subtype` | | str | 상위 카테고리 |
| `effective_time` | | datetime | 효력 발생 시각 |
| `polarity` | | str | positive/negative/neutral/mixed |
| `certainty` | | str | disclosed/reported/estimated/speculated |
| `representative_source_type` | | str | 대표 출처 유형 |
| `confidence` | | float | 추출 confidence |
| `trigger_text` | | str | 대표 트리거 표현 |
| `status` | | str | active / retracted |
| `created_at` | | datetime | |
| `updated_at` | | datetime | |

**적재 조건:**
- `canonical_event_id` 존재
- `event_type` 존재
- `event_time` 존재 (없으면 `published_at`으로 대체)
- `subject_entity_id` 또는 최소 1개 이상의 resolved related entity 존재

**스킵 조건:**
- EventCandidate 단계 결과 (canonical event가 아닌 것)
- 동일 사건 여부 미정 상태
- factuality = "rumor" AND confidence < 0.5

---

### EventCandidate (중간 노드)

```
Label:      EventCandidate
Unique Key: event_candidate_id
```

canonicalization 이전 단계의 이벤트 후보를 그래프에 유지한다. `CANONICALIZED_TO` 엣지로 CanonicalEvent와 연결되며, Evidence Retriever가 개별 문서 수준의 근거를 조회할 때 활용된다.

---

### Document

```
Label:      Document
Unique Key: canonical_doc_id
```

| 속성 | 필수 | 타입 | 설명 |
|------|------|------|------|
| `canonical_doc_id` | ✓ | str | 문서 고유 키 |
| `source_type` | ✓ | str | filing / news |
| `title` | ✓ | str | 문서 제목 |
| `trust_tier` | | int | 출처 신뢰도 (1~5) |
| `published_at` | | datetime | |
| `updated_at` | | datetime | |
| `source_url` | | str | |
| `doc_status` | | str | active / superseded / duplicate |
| `created_at` | | datetime | |

---

### Evidence

```
Label:      Evidence
Unique Key: evidence_id (SHA-1 기반 생성)
```

| 속성 | 필수 | 타입 | 설명 |
|------|------|------|------|
| `evidence_id` | ✓ | str | 고유 키 |
| `text` | ✓ | str | 원문 텍스트 |
| `canonical_doc_id` | | str | 출처 문서 ID |
| `sentence_id` | | str | 출처 문장 ID |
| `char_start` / `char_end` | | int | 오프셋 |
| `extraction_method` | | str | 추출 방법 |
| `confidence` | | float | |
| `created_at` | | datetime | |

**스킵 조건:**
- 문장 정렬 실패 (sentence_id 매핑 불가)
- span 길이가 `max_sentence_length`를 초과

---

### Region / Institution / Commodity

모두 동일한 최소 스키마를 따른다.

| 속성 | 필수 | 설명 |
|------|------|------|
| `{type}_id` | ✓ | 고유 키 |
| `name` | ✓ | 명칭 |

---

## 3. 엣지 스키마

### BELONGS_TO_INDUSTRY

```cypher
(:Company)-[:BELONGS_TO_INDUSTRY]->(:Industry)
```

| 속성 | 설명 |
|------|------|
| `source` | 매핑 출처 |
| `confidence` | |
| `valid_from` | 유효 시작 시각 |
| `updated_at` | |

**생성 조건:** Company 노드 존재 + Industry 노드 존재 + reference data 기반 매핑
**금지 조건:** 기사 단일 문맥만으로 추론

---

### HAS_EVENT

```cypher
(:Company)-[:HAS_EVENT {role:"subject"}]->(:Event)
```

| 속성 | 설명 |
|------|------|
| `role` | 항상 "subject" |
| `confidence` | |
| `updated_at` | |

**생성 조건:** `canonical_event.subject_entity_id`가 Company로 resolution 완료
**금지 조건:** subject가 unresolved / generic placeholder

---

### INVOLVES

```cypher
(:Event)-[:INVOLVES]->(:Company|:Institution|:Region|:Commodity)
```

| 속성 | 설명 |
|------|------|
| `role` | counterparty / regulator / region / commodity 등 |
| `confidence` | |
| `updated_at` | |

**생성 조건:** event frame의 object/related slot 존재 + 해당 엔티티 resolution 완료
**금지 조건:** role 불명확 / unresolved entity

---

### SUPPORTED_BY → FROM_DOCUMENT

```cypher
(:Event)-[:SUPPORTED_BY]->(:Evidence)-[:FROM_DOCUMENT]->(:Document)
```

이벤트의 모든 EvidenceSpan에 대해 생성. 에이전트의 Evidence Retriever가 이 경로를 탐색한다.

---

### PRECEDES

```cypher
(:Event1)-[:PRECEDES {lag_days: N}]->(:Event2)
```

| 속성 | 설명 |
|------|------|
| `lag_days` | 두 이벤트 간 일 단위 시간 차 |
| `confidence` | |
| `updated_at` | |

**생성 조건:**
- 두 Event 모두 canonical event
- 동일 company 또는 동일 사건군 내
- `event_time(E1) < event_time(E2)`
- 시간 차 ≤ `precedes_max_lag_days` (Neo4jConfig 기본값: 30일)

**금지 조건:** 단순 시간 정렬만으로 무차별 생성

---

### CANONICALIZED_TO

```cypher
(:EventCandidate)-[:CANONICALIZED_TO]->(:Event)
```

Event Canonicalization 결과를 그래프에 표현. 하나의 Event에 복수의 EventCandidate가 연결된다.

---

## 4. InMemoryGraphStore 구조

실제 Neo4j가 아닌 인메모리 구현(`graph_loader.py`)을 사용한다.

```python
class InMemoryGraphStore:
    nodes: Dict[str, GraphNode]        # node_id → GraphNode
    edges: List[GraphEdge]             # 전체 엣지 목록
    passage_index: PassageIndex        # 이벤트 → 원문 passage 인덱스
```

`get_subgraph(seed_ids, max_hops, min_confidence, edge_types)` 메서드로 에이전트가 subgraph를 탐색한다.

### PassageIndex 구조

```python
class PassageIndex:
    documents: Dict[str, DocumentTextRecord]       # doc_id → 문서 메타
    passages: Dict[str, PassageRecord]             # passage_id → 원문 텍스트
    event_to_passage_ids: Dict[str, List[str]]     # event_id → passage_id 목록
    event_candidate_to_passage_ids: ...
    document_to_passage_ids: ...
```

에이전트의 Evidence Retriever는 `event_to_passage_ids`로 이벤트에서 원문 passage를 직접 조회한다.

---

## 5. 설계 의사결정 근거

**왜 Neo4j가 아닌 InMemoryGraphStore를 사용하는가?**
현재 시스템은 로컬 개발 및 검증 단계다. InMemoryGraphStore는 Neo4j와 동일한 `GraphPayload` 인터페이스를 사용하므로, 이후 Neo4j 연동 시 `load_payload()` 메서드만 교체하면 된다. 설정은 `Neo4jConfig`에 이미 정의되어 있다(`bolt://localhost:7687`).

**왜 Event와 EventCandidate를 모두 노드로 유지하는가?**
Canonicalization은 확률적 판단이므로 오병합 가능성이 있다. EventCandidate를 별도 노드로 유지하면 개별 문서 수준에서 근거를 재검증하거나 오병합을 탐지할 수 있다.
