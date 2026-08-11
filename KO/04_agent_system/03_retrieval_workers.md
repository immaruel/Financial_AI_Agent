# 03. Retrieval Worker: Graph / Hybrid / Document-block

## 1. 목적

`RetrievalPolicy.channels`에 선택된 worker만 병렬로 실행되어 `EvidenceBlock` 후보를 만든다. 세 worker는 서로 다른 자원과 알고리즘을 쓰지만, 모두 같은 `EvidenceBlock` 단위로 결과를 반환하므로 이후 fusion/rerank/verification이 채널에 무관하게 동작한다.

| Worker | 클래스 | 대상 |
|---|---|---|
| Graph | `GraphRetrievalWorker` (`retrieval/graph.py`) | 지식그래프 관계 경로 → 연결된 원문 evidence |
| Hybrid (lexical + vector) | `HybridRetrievalWorker` (`retrieval/hybrid.py`) | 문단/각주 중심 원문 검색 |
| Document-block | `HybridRetrievalWorker(document_blocks_only=True)` | 표/표 셀/그림/캡션 |

---

## 2. 공통 근거 단위: EvidenceBlock

모든 채널은 `EvidenceCatalog`(`retrieval/hybrid.py`)가 `InMemoryGraphStore.passage_index`로부터 만든 동일한 `EvidenceBlock` 카탈로그를 조회한다.

```json
{
  "evidence_id": "ev_456",
  "document_id": "doc_123",
  "block_id": "blk_17",
  "source_type": "filing",
  "source_url": "https://...",
  "published_at": "2026-05-10T20:00:00+09:00",
  "effective_at": "2026-03-31T00:00:00+09:00",
  "effective_period": "2026Q1",
  "block_type": "table_cell",
  "text": "...",
  "locator": {
    "page": 42,
    "section": "매출액 또는 손익구조 변동",
    "table_id": "table_7",
    "row": "매출액",
    "column": "당기",
    "char_start": 1024,
    "char_end": 1320
  },
  "structured": {"grid": [...], "headers": [...]},
  "content_hash": "sha256:...",
  "citable": true,
  "synthetic": false,
  "derivation": "native_text",
  "human_reviewed": false,
  "retrieval_channels": ["lexical", "graph"],
  "retrieval_scores": {"rrf": 0.031, "reranker": 4.2}
}
```

`evidence_id`는 `document_id + block_id + sentence_id + content_hash`의 sha256으로 결정적으로 생성되므로, 동일 원문 조각은 채널이 달라도 같은 ID로 병합된다. `EvidenceCatalog.snapshot_id`는 전체 카탈로그의 해시로, 동일 질의를 같은 인덱스 스냅샷에서 재현 가능하게 한다.

### 2.1 원문 block과 artifact 보존

수집기(`collection/source_connector.py`, `collection/document_parser.py`)는 DART ZIP/XML, 발행사 HTML, PDF를 원본 그대로 `artifact_store`에 불변 저장하고, 파싱 결과를 `paragraph`/`heading`/`table`/`table_cell`/`figure`/`caption`/`image`/`footnote` block으로 분리한다. 표는 사람이 읽는 text와 `headers`/`rows` 구조를 함께 유지하고, figure는 페이지·DOM 위치·캡션·주변 문단을 연결한다. `EvidenceBlock.locator`가 비어 있거나(`page`/`xpath`/`table_id`/`char_start·end` 전부 없음) `source_url`이 없으면 클릭 가능한 인용으로 취급하지 않는다 — 이 조건은 [04_evidence_and_claims.md](04_evidence_and_claims.md)의 Evidence Requirement Gate와 [05_verification_and_answer_gate.md](05_verification_and_answer_gate.md)의 locator 검증에서 강제된다.

OCR/vision으로 읽은 수치(`derivation in {ocr, vision, mixed}`)는 `human_reviewed=True`가 아니면 numeric evidence로 인정하지 않는다. 스캔 문서의 수치를 원문 표 없이 자동 신뢰하지 않기 위한 제약이다.

---

## 3. Graph Retrieval Worker

### 3.1 입력 / 출력

| 항목 | 설명 |
|---|---|
| 입력 | `QuerySpec`, `RetrievalPolicy`, `InMemoryGraphStore` |
| 출력 | `GraphWorkerOutput(result: WorkerResult, evidence: List[EvidenceBlock], paths: List[GraphPath], subgraph: SubGraphResult)` |

### 3.2 처리 단계

```text
1. Seed 탐색: QuerySpec.entities의 canonical_id가 그래프에 존재하면 그대로 사용,
   없으면 canonical_name/surface로 그래프의 Company 노드를 alias 매칭
2. seed가 하나도 없으면 즉시 실패 (ENTITY_UNRESOLVED, non-retryable)
3. 의도별 hop 수: graph_mode == "primary"면 3-hop, 아니면 2-hop
4. 의도별 허용 edge type으로 BFS subgraph 탐색 (min_edge_confidence 이하 edge 제외)
5. 발행/사업 기간 필터 적용 (published_at, effective_at/effective_period)
6. seed에서 시작하는 관계 path 구성 (최대 3-hop, 최대 20개), edge마다
   confidence/inference_method/causal 플래그를 path.edge_metadata에 보존
7. path가 지나는 Event/EventCandidate/Document/DocumentBlock의 연결된
   passage를 PassageIndex에서 찾아 EvidenceBlock으로 확장
8. path별로 실제 도달 가능한 evidence_id만 GraphPath.evidence_ids에 연결
```

### 3.3 결과 상태

| 조건 | status | failure code |
|---|---|---|
| seed 없음 | FAILED | `ENTITY_UNRESOLVED` (non-retryable) |
| seed는 있지만 path/노드 없음 | FAILED | `RETRIEVAL_EMPTY` (retryable) |
| path는 있지만 인용 가능한 evidence 없음 | PARTIAL | `INSUFFICIENT_PRIMARY_EVIDENCE` (retryable) |
| path + evidence 모두 확보 | SUCCESS | — |

### 3.4 인과 관계 표현

`GraphPath.edge_metadata`의 각 edge는 `inference_method`(예: `heuristic_temporal_adjacency`)와 `causal`(bool)을 함께 담는다. `PRECEDES`처럼 시간 선후만 나타내는 edge는 `causal=False`로 표시되어, claim 생성과 검증 단계가 이를 인과로 오인하지 않게 한다. `CAUSED_BY` edge만 `causal=True`가 될 수 있다.

---

## 4. Hybrid Retrieval Worker (Lexical + Vector)

### 4.1 구성 요소

| 구성 | 클래스 | 방식 |
|---|---|---|
| Lexical | `LexicalRetriever` | 로컬 BM25 (k1=1.5, b=0.75), 한글 2-gram 확장 토크나이저 |
| Dense | `DenseRetriever` | `BAAI/bge-m3` 어댑터. 모델 로드/추론 실패 시 명시적 `deterministic_hashing_fallback`으로 표시(가짜로 성공했다고 하지 않음) |
| Fusion | `_rrf()` / `fuse_ranked_evidence()` | Reciprocal Rank Fusion (`rrf_k` 기본 60) |
| Rerank | `Reranker` | cross-encoder(`BAAI/bge-reranker-v2-m3`) 우선, 실패 시 `deterministic_overlap_fallback` |

`document_blocks_only=True`로 호출하면 `block_types = (table, table_cell, figure, caption, image)`만 대상으로 동일한 lexical/vector/RRF/rerank 파이프라인을 실행한다 — worker 이름만 `document_block_retrieval`로 바뀔 뿐 알고리즘은 동일하다.

### 4.2 실행 순서

```text
1. EvidenceCatalog.select(): as_of, source_filters, block_types, date_filter로 후보 corpus 필터
2. corpus가 비면 즉시 FAILED(RETRIEVAL_EMPTY)
3. lexical/vector 채널을 병렬 실행 (ThreadPoolExecutor)
4. relative_sort == "published_desc"인 질의는 recency 전용 lane을 추가해
   "최신" 요청이 관련성 동점 처리 때문에 오래된 문서로 잘리지 않게 함
5. 채널별 RetrievalHit를 RRF로 융합 -> Reranker.rerank() -> evidence_budget으로 절단
6. prioritize_relative_order()로 planner가 요청한 상대 정렬(published_desc 등) 최종 적용
```

### 4.3 결과 상태

| 조건 | status | failure code |
|---|---|---|
| corpus 없음 | FAILED | `RETRIEVAL_EMPTY` |
| 융합 결과 없음 | FAILED | `RETRIEVAL_EMPTY` |
| 일부 채널 실패 또는 모델 fallback 사용 | PARTIAL | `RETRIEVAL_DEGRADED` / `MODEL_FALLBACK` / `MODEL_UNAVAILABLE` |
| 정상 | SUCCESS | — |

모델이 사용 불가능해 결정적 fallback으로 전환된 경우에도 결과 자체는 반환하되, `WorkerResult.failure`와 `ToolCallTrace.backend`에 실제 사용된 backend(예: `deterministic_hashing_fallback`)를 정직하게 기록한다.

---

## 5. Evidence Fusion과 두 검색 결과의 융합 규칙

Graph worker의 후보와 hybrid worker의 후보를 노드 ID/passage rank 단계에서 직접 섞지 않는다. Graph 결과는 **먼저 EvidenceBlock으로 확장**된 뒤에만 lexical/vector 결과와 동일한 근거 단위에서 RRF로 합쳐진다.

```text
graph seed → Event/Document → EvidenceBlock rank list
BM25 → EvidenceBlock rank list
vector → EvidenceBlock rank list
                           ↓
                       fuse_ranked_evidence() (RRF, 채널별 rank 병합)
                           ↓
                  Reranker (cross-encoder 또는 결정적 fallback)
                           ↓
             prioritize_relative_order() (상대 시간 정렬 최종 적용)
```

`AgentOrchestrator._fuse_and_rerank()`가 이 단계를 담당하며, 결과와 함께 `evidence_fusion_reranker`라는 이름의 `ToolCallTrace`를 남긴다(사용된 backend, degraded 여부 포함).

---

## 6. Harness 관점의 검증 포인트

| 항목 | 의미 |
|------|------|
| `seed_precision` / `seed_recall` | QuerySpec entity로 올바른 시작 노드를 찾았는가 |
| `subgraph_recall@k` | 정답에 필요한 핵심 이벤트/기업/문서를 포함했는가 |
| `evidence_recall@k` / `evidence_precision@k` | 채널이 답변에 필요한 원문을 회수했는가 |
| `locator_valid_rate` | 반환한 evidence가 실제 페이지·문단·표 위치로 이동 가능한가 |
| `channel_degradation_rate` | 전용 검색 모델 대신 결정적 fallback이 얼마나 자주 쓰였는가 |
| `fusion_backend distribution` | reranker가 cross-encoder인지 fallback인지 |

retrieval trace에는 seed node id, seed 탐색 방식, hop 수, 허용 edge type, pruning 전후 크기, 채널별 backend, snapshot_id를 남긴다.

대표 실패 유형: F1 엔티티 혼동, F2 시간축 오류, F5 근거 누락의 upstream 원인.

---

## 7. 설계 의사결정 근거

**왜 graph를 최종 사실 근거로 쓰지 않는가?**
그래프는 관계와 후보 문서를 빠르게 좁히지만, 원문 문장·표·화자 위치를 보증하지 않는다. 금융 답변의 핵심 claim은 EvidenceBlock에서 직접 인용·수치·시간 검증을 통과해야 한다.

**왜 lexical/vector를 같은 worker(HybridRetrievalWorker) 안에서 병렬 실행하는가?**
두 채널은 같은 corpus·같은 evidence_budget·같은 fusion 규칙을 공유하며, 정확한 회사명·숫자는 BM25가, 의미가 같지만 표현이 다른 문장은 BGE-M3가 강하다. 하나의 worker로 묶으면 채널 간 fallback·trace·재시도 로직을 한 곳에서 일관되게 관리할 수 있다.

**왜 모델이 없을 때 결정적 fallback으로 "정직하게" 표시하는가?**
BGE-M3/reranker가 로드되지 않았을 때 조용히 lexical 결과만 반환하면 "검색이 잘 됐다"는 착각을 준다. `backend` 필드와 `MODEL_FALLBACK`/`MODEL_UNAVAILABLE` failure code로 남겨야 이후 품질 저하의 원인을 재현·추적할 수 있다.
