# 04. Entity Resolution

## 1. 목적

타입이 확정된 `TypedMention`을 분석하여, 서로 다른 표기가 실제로 같은 대상을 가리키는지 판별하고 하나의 `canonical_entity_id`로 연결한다.

예시: "현대차", "HMC", "현대자동차(주)" → `entity_hyundai_motor`

해소 불가능한 mention은 placeholder를 생성하여 이후 그래프에서 `CounterpartyPlaceholder` 노드로 관리된다. 이 단계의 출력이 KG에서 노드의 고유 식별자를 결정한다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `Dict[doc_id, List[TypedMention]]` | 타입 분류 완료 mention |
| `Dict[doc_id, PreprocessedDocument]` | 문장 컨텍스트 |
| `ReferenceDataManager` | canonical entity 사전 (ID + alias 목록) |
| `EntityResolutionConfig` | 유사도 임계값 |

### 출력

`Dict[canonical_doc_id, List[ResolvedMention]]`

`ResolvedMention` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `mention_id` | str | 원본 mention ID 승계 |
| `mention_text` | str | 원문 텍스트 |
| `sentence_id` | str | 출처 문장 ID |
| `entity_type` | str | 확정된 타입 |
| `canonical_entity_id` | str | 해소된 canonical ID |
| `canonical_name` | str | 공식 명칭 |
| `resolution_method` | str | 해소 방법 식별자 |
| `resolution_confidence` | float | 해소 confidence |
| `resolution_status` | ResolutionStatus | `resolved` / `placeholder` / `unresolved` |

---

## 3. 처리 로직

`entity_type`별로 다른 해소 전략을 적용한다.

### 3.1 Company 해소

4단계 순서로 진행된다.

```
1단계: Exact Alias Match
  mention_text가 alias_dict에 정확히 존재
  → resolution_status = "resolved"
  → resolution_method = "exact_alias"

2단계: Fuzzy Match (threshold: 80)
  rapidfuzz.fuzz.partial_ratio(mention_text, alias) >= alias_fuzzy_threshold
  → resolution_status = "resolved"
  → resolution_method = "fuzzy_alias"

3단계: Embedding 유사도 (top-k 후보 중 가장 유사한 것)
  cosine_similarity(embed(mention_text), embed(candidate)) >= embedding_similarity_threshold(0.80)
  → resolution_status = "resolved"
  → resolution_method = "embedding"

4단계: Placeholder 생성
  모든 단계 실패 또는 confidence < placeholder_confidence(0.50)
  → canonical_entity_id = "company_placeholder_{index:06d}"
  → resolution_status = "placeholder"
```

### 3.2 Industry / Institution / Region / Commodity 해소

Exact Match만 수행한다. 매칭 실패 시 UNRESOLVED로 처리된다.

```
mention_text가 reference_dict에 정확히 존재
  → resolution_status = "resolved"

매칭 실패
  → resolution_status = "unresolved"
  → 이후 그래프 적재 시 스킵
```

### 3.3 MoneyAmount / Date / Percentage / EventTrigger 해소

별도의 canonical ID를 부여하지 않는다. 이들은 노드가 아닌 이벤트 속성(slot)으로 처리되므로, resolution_status="resolved"로 표시하되 canonical_entity_id는 None이다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- `entity_type_classifier.py` → `TypedMention`
- `reference/company_data.py` → alias 사전, canonical_entity_id 매핑

### Downstream
- `event_extractor.py` → `ResolvedMention`에서 subject/object entity를 참조
- `graph_loader.py` → `canonical_entity_id`를 그래프 노드 키로 사용

### 외부 의존성
- `rapidfuzz`: alias fuzzy matching
- 임베딩 모델 (`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`): embedding 유사도
- `EntityResolutionConfig` (config/settings.py)

---

## 5. 데이터 흐름 내 위치

```
[Entity Type Classifier]
        │  Dict[doc_id, List[TypedMention]]
        ▼
[Entity Resolver]   ← 이 문서
        │  Dict[doc_id, List[ResolvedMention]]
        ├──→ [Event Extractor]   (subject/object entity 결정)
        └──→ [Graph Loader]      (노드 생성 시 canonical_entity_id 사용)
```

---

## 6. 구현 기준 설계

### Placeholder 관리

`company_placeholder_{index:06d}` 형식으로 내부 ID를 생성한다. Placeholder는 KG에서 별도 노드 타입(`CounterpartyPlaceholder`)으로 적재되며, 이후 추가 증거가 수집되면 실제 Company 노드로 업데이트 가능하다.

### 해소 통계 로깅

```python
resolved_count = sum(
    1 for rlist in resolved_by_doc.values()
    for r in rlist if r.resolution_status.value == "resolved"
)
logger.info(f"Entity Resolution → {resolved_count} resolved")
```

파이프라인 실행 시 `resolved` 비율이 낮으면 사전 품질 또는 NER 정확도 문제를 의심한다.

### 배치 처리 메서드

```python
resolve_batch(
    typed_by_doc: Dict[str, List[TypedMention]],
    doc_map: Dict[str, PreprocessedDocument]
) -> Dict[str, List[ResolvedMention]]
```

---

## 7. 설계 의사결정 근거

**왜 Company만 4단계 해소 전략을 사용하는가?**
기업명은 약칭·영문명·구 사명 등 표기 변형이 가장 다양하다. 반면 산업·지역 명칭은 표준 분류체계가 있어 exact match로 충분하다. Company 해소에 embedding을 추가 적용하는 것은 이 변형 다양성을 처리하기 위한 것이다.

**왜 해소 불가 시 삭제 대신 placeholder를 생성하는가?**
이벤트 프레임에서 거래 상대방이 미상이더라도 "미상의 거래처와 계약"이라는 사실 자체는 유의미하다. Placeholder로 보존하면 이후 근거가 누적될 때 실제 엔티티로 대체할 수 있고, 그래프에서 "미확인 연관 기업" 패턴도 탐색 가능하다.
