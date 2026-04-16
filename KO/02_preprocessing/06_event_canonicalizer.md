# 06. Event Canonicalization

## 1. 목적

여러 문서에서 추출된 `EventCandidate`를 비교하여, 실질적으로 같은 사건이면 하나의 `CanonicalEvent`로 병합한다.

이 단계는 **3차 중복 제거 계층**이다. 1차(문서 기준 중복 판별)와 2차(이벤트 후보 추출) 이후, 이벤트 단위에서 최종적으로 중복을 제거한다. 이 단계가 없으면 동일 사건이 뉴스 보도 수만큼 KG에 중복 적재된다.

하네스 엔지니어링 관점에서 Event Canonicalization은 **오프라인 계층의 failure localization 핵심 지점**이다. 여기서 잘못 병합되면 이후 retrieval, evidence 회수, reasoning, answer까지 모두 흔들린다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `List[EventCandidate]` | 전체 문서에서 추출된 이벤트 후보 목록 |
| `EventCanonicalizationConfig` | 유사도 임계값, 시간 윈도우, 필드 가중치 |

### 출력

`List[CanonicalEvent]`

`CanonicalEvent` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `canonical_event_id` | str | UUID (prefix: `canon_evt_`) |
| `event_type` | str | 대표 이벤트 타입 |
| `event_subtype` | str | 대표 서브타입 |
| `subject_entity_id` | str | 주체 canonical_entity_id |
| `object_entity_id` | str | 대상 canonical_entity_id |
| `amount` | float | 대표 금액 (공시 우선) |
| `currency` | str | 통화 (기본: KRW) |
| `event_time` | datetime | 대표 발생 시각 |
| `effective_time` | datetime | 대표 효력 시각 |
| `polarity` | Polarity | 대표 극성 |
| `certainty` | Certainty | 대표 확실성 |
| `source_event_candidate_ids` | List[str] | 병합된 EventCandidate ID 목록 |
| `source_canonical_doc_ids` | List[str] | 근거 문서 ID 목록 |
| `representative_source_type` | str | 대표 출처 유형 |
| `confidence` | float | 최고 신뢰도 |
| `trigger_text` | str | 대표 트리거 표현 |
| `evidence` | List[EvidenceSpan] | 수집된 모든 근거 span |

---

## 3. 처리 로직

### 3.1 후보군 제한 (Blocking)

전체 EventCandidate를 전부 비교하지 않고, 아래 조건을 동시에 만족하는 후보끼리만 비교한다.

```
블로킹 조건 (모두 만족해야 비교 대상):
  - 동일 event_type
  - 동일 subject_entity_id
  - event_time 차이 ≤ time_window_days (기본: 7일)
```

### 3.2 유사도 계산

블로킹 후보 내에서 아래 필드별 유사도를 가중 합산한다.

| 필드 | 가중치 | 비교 방법 |
|------|--------|-----------|
| `event_type` | 0.25 | 동일 여부 (1.0 / 0.0) |
| `subject_entity_id` | 0.25 | 동일 여부 (1.0 / 0.0) |
| `object_entity_id` | 0.15 | 동일/None 처리 |
| `amount` | 0.15 | 정규화 수치 유사도 |
| `event_time` | 0.10 | 일 단위 시간 차 역수 |
| `trigger_text` | 0.10 | 텍스트 유사도 |

```python
similarity = sum(
    field_weights[field] * similarity_score(cand_a[field], cand_b[field])
    for field in field_weights
)
```

### 3.3 판정 기준

| similarity | 처리 |
|------------|------|
| ≥ 0.85 (`same_event_threshold`) | 확정 병합 → 동일 CanonicalEvent에 합산 |
| 0.65 ~ 0.85 (`maybe_same_threshold`) | 낮은 confidence로 병합 (경고 플래그) |
| < 0.65 | 별개 사건 → 각자 새 CanonicalEvent 생성 |

### 3.4 대표값 결정 (병합 시)

같은 사건으로 묶인 EventCandidate 중 아래 우선순위로 대표값을 선택한다.

```python
source_priority = {
    "filing": 1,    # 공시 최우선
    "news": 2,
    "analysis": 3,
}
```

| 속성 | 대표값 결정 규칙 |
|------|----------------|
| `amount` | `source_type == "filing"`인 후보의 값 우선 |
| `event_time` | 공시의 `effective_time` 우선, 없으면 가장 이른 `event_time` |
| `representative_source_type` | 가장 낮은 source_priority의 source_type |
| `confidence` | 병합된 후보 중 최고값 |
| `evidence` | 모든 후보의 EvidenceSpan을 합산 보존 |
| `source_canonical_doc_ids` | 근거 문서 전체 목록 유지 |

---

## 4. 의존성 및 연계 모듈

### Upstream
- `event_extractor.py` → `EventCandidate` 리스트

### Downstream
- `graph_loader.py` → `CanonicalEvent`를 Event 노드로 변환
- PassageIndex → `CanonicalEvent.evidence`에서 passage를 인덱싱

### 외부 의존성
- `EventCanonicalizationConfig` (config/settings.py): 임계값, 가중치, 시간 윈도우

---

## 5. 데이터 흐름 내 위치

```
[Event Extractor]
        │  List[EventCandidate] (전체 문서)
        ▼
[Event Canonicalizer]   ← 이 문서
        │  List[CanonicalEvent]
        ▼
[Graph Loader]  →  Event 노드 + HAS_EVENT 엣지 + PRECEDES 엣지
```

---

## 6. Harness 관점의 검증 포인트

Event Canonicalization은 아래 항목을 별도로 평가하는 것이 좋다.

| 항목 | 의미 |
|------|------|
| `canonical_grouping_accuracy` | 실질적으로 같은 사건을 올바르게 묶었는가 |
| `over_merge_rate` | 다른 사건을 하나로 과도 병합하지 않았는가 |
| `under_merge_rate` | 같은 사건을 여러 canonical event로 남기지 않았는가 |
| `representative_value_accuracy` | 대표 금액/시간/출처 선택이 적절한가 |
| `event_to_evidence_preservation` | 병합 후 evidence가 충분히 보존되는가 |

추천 trace:

- candidate -> canonical_event 매핑
- similarity score
- blocking key
- low-confidence merge 여부
- representative source 선택 근거

대표 실패 유형:

- F2 시간축 오류
- F3 숫자 오류
- F4 이벤트 귀속 오류
- F5 근거 누락

---

## 7. 구현 기준 설계

### 처리 흐름

```python
def canonicalize(self, event_candidates: List[EventCandidate]) -> List[CanonicalEvent]:
    canonical_events = []

    for candidate in event_candidates:
        # 1. 블로킹: 비교 대상 후보군 선택
        comparison_pool = self._get_comparison_pool(candidate, canonical_events)

        # 2. 유사도 계산
        best_match, best_score = self._find_best_match(candidate, comparison_pool)

        # 3. 판정 및 병합
        if best_score >= self.config.same_event_threshold:
            self._merge_into(candidate, best_match)
        elif best_score >= self.config.maybe_same_threshold:
            self._merge_into(candidate, best_match, low_confidence=True)
        else:
            canonical_events.append(self._create_new(candidate))

    return canonical_events
```

### Evidence 합산 보존

병합 시 모든 후보의 `EvidenceSpan`을 합산하여 CanonicalEvent에 보존한다. 이는 에이전트의 Evidence Retriever가 동일 사건에 대한 여러 출처의 원문을 교차 검증할 수 있게 한다.

---

## 8. 설계 의사결정 근거

**왜 블로킹을 사용하는가?**
N개의 EventCandidate를 전부 비교하면 O(N²) 비교가 발생한다. 대규모 문서에서는 수만 건의 후보가 생성되므로, `event_type + subject_entity_id + time_window` 조건으로 먼저 후보군을 제한하면 실질적으로 O(N × k) (k는 블로킹 후 평균 후보 수)로 복잡도를 줄일 수 있다.

**왜 0.65~0.85 구간을 별도 처리하는가?**
뉴스 보도는 공시 대비 금액·시간 정보가 불완전한 경우가 많아, 실질적으로 같은 사건임에도 유사도가 0.85에 미치지 못할 수 있다. 이 구간을 낮은 confidence로 병합하면 사건 정보를 잃지 않으면서도, 에이전트가 불확실한 병합임을 인지할 수 있다.
