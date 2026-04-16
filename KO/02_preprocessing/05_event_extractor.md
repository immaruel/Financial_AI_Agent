# 05. 이벤트 추출 (Event Extractor)

## 1. 목적

`PreprocessedDocument`의 문장과 `ResolvedMention`을 결합하여 **Event Frame**을 생성한다. 문서 중심 정보를 사건(이벤트) 중심으로 변환하는 단계로, 금융 KG에서 질의의 핵심 단위가 되는 `EventCandidate`를 출력한다.

이벤트 추출이 필요한 근본 이유: 사용자 질문은 "회사"가 아닌 "사건"을 묻는 경우가 대부분이며, 이후 Event Canonicalization에서 동일 사건의 중복 문서를 병합하려면 사건 프레임이 먼저 구성되어야 한다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `PreprocessedDocument` | 문장 목록, doc_subtype, 메타데이터 |
| `List[ResolvedMention]` | 해당 문서의 해소된 엔티티 목록 |
| `EventExtractionConfig` | event confidence 임계값, factuality 키워드 |
| `NERConfig` | trigger lexicon (이벤트 타입 트리거 사전) |

### 출력

`List[EventCandidate]`

`EventCandidate` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `event_candidate_id` | str | UUID (prefix: `evt_cand_`) |
| `canonical_doc_id` | str | 출처 문서 ID |
| `source_type` | SourceType | 문서 유형 |
| `event_type` | str | 이벤트 타입 (14개 중 하나) |
| `event_subtype` | str | 이벤트 서브타입 |
| `subject_entity_id` | str | 주체 엔티티 canonical ID |
| `object_entity_id` | str | 대상 엔티티 canonical ID (없을 수 있음) |
| `trigger_text` | str | 이벤트를 촉발한 표현 |
| `amount` | MoneyAmount | 금액 정보 (있는 경우) |
| `event_time` | datetime | 이벤트 발생 시각 |
| `certainty` | Certainty | `disclosed` / `reported` / `estimated` / `speculated` |
| `factuality` | Factuality | `fact` / `interpretation` / `rumor` / `unknown` |
| `polarity` | Polarity | `positive` / `negative` / `neutral` / `mixed` |
| `evidence` | List[EvidenceSpan] | 근거 문장 목록 |
| `confidence` | float | 이벤트 추출 confidence |
| `slots` | Dict | 추가 속성 슬롯 |

---

## 3. 처리 로직

### 3.1 Trigger 탐지

문장 내 `EventTrigger` 타입 mention(NER 단계에서 trigger_lexicon으로 추출된 것)을 탐색한다. Trigger가 존재하는 문장에서 Event Frame 생성을 시작한다.

### 3.2 Subject / Object 배정

```
Trigger 위치 기준으로:
  - Trigger에 가장 가까운 Company mention → subject_entity_id
  - 두 번째 Company mention 또는 Placeholder → object_entity_id
```

문서가 `filing` 타입인 경우, 공시 발행 법인(`corp_code`)이 subject로 우선 배정된다.

### 3.3 Slot Filling

이벤트 타입별로 필요한 슬롯을 해당 문장 또는 인접 문장의 mention에서 채운다.

| 슬롯 | 소스 mention 타입 |
|------|-----------------|
| `amount` | MoneyAmount |
| `event_time` | Date |
| `percentage` | Percentage |

### 3.4 Factuality 판정

문장 내 키워드를 기반으로 factuality를 결정한다.

**Fact 키워드** (확정 사실):
`밝혔다, 공시했다, 발표했다, 보고했다, 확인됐다, 체결했다, 완료했다, 결정했다`

**Interpretation 키워드** (해석·예측):
`전망이다, 것으로 보인다, 예상된다, 관측된다, 가능성이, 우려가, 기대감, 분석했다, 평가했다`

```
fact_keywords 포함      → factuality = "fact",           certainty = "disclosed"
interpretation_keywords → factuality = "interpretation", certainty = "estimated"
기본값                   → factuality = "unknown",        certainty = "reported"
```

### 3.5 이벤트 타입 계층 구조

14개 leaf 타입의 전체 계층 정의는 [03_knowledge_graph/01_ontology.md §3.2](../03_knowledge_graph/01_ontology.md)를 참조한다.

`event_type`은 leaf 타입(ContractEvent 등), `event_subtype`은 상위 카테고리(CorporateAction 등)를 저장한다. Trigger lexicon에서 탐지된 키워드가 어느 leaf 타입에 속하는지는 `NERConfig.trigger_lexicon`에서 정의된다.

### 3.6 EvidenceSpan 생성

이벤트가 추출된 문장을 `EvidenceSpan`으로 보존한다.

```python
EvidenceSpan(
    canonical_doc_id=doc.canonical_doc_id,
    sentence_id=sentence.sentence_id,
    text=sentence.text,
    char_start=sentence.char_start,
    char_end=sentence.char_end,
)
```

이 EvidenceSpan은 이후 `PassageIndex`에 인덱싱되어, 에이전트의 Evidence Retriever가 원문을 회수할 때 사용된다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- `doc_preprocessor.py` → `PreprocessedDocument`
- `entity_resolver.py` → `ResolvedMention` 리스트

### Downstream
- `event_canonicalizer.py` → `EventCandidate` 리스트를 받아 중복 병합
- `graph_loader.py` → `EventCandidate`의 EvidenceSpan이 PassageIndex로 인덱싱됨

### 외부 의존성
- `EventExtractionConfig` (config/settings.py): confidence 임계값, factuality 키워드
- `NERConfig.trigger_lexicon` (config/settings.py): 이벤트 트리거 사전

---

## 5. 데이터 흐름 내 위치

```
[Entity Resolver]
        │  List[ResolvedMention]
        │
[Document Preprocessor]
        │  PreprocessedDocument
        ▼
[Event Extractor]   ← 이 문서
        │  List[EventCandidate]
        ▼
[Event Canonicalizer]
```

---

## 6. 구현 기준 설계

### 단일 문서 처리 메서드

```python
def extract(
    self,
    doc: PreprocessedDocument,
    resolved_mentions: List[ResolvedMention]
) -> List[EventCandidate]
```

`main.py`에서 각 문서별로 순차 호출된다.

```python
all_event_candidates = []
for doc in preprocessed_docs:
    resolved = resolved_by_doc.get(doc.canonical_doc_id, [])
    events = self.event_extractor.extract(doc, resolved)
    all_event_candidates.extend(events)
```

### Confidence 계산

```python
base_confidence = trigger_confidence   # trigger_lexicon: 0.70
if subject_entity_id and resolution_status == "resolved":
    base_confidence += 0.15
if factuality == "fact":
    base_confidence += 0.10
if amount or event_time:
    base_confidence += 0.05

final_confidence = min(base_confidence, 1.0)
```

`event_confidence_threshold(0.50)` 미만이면 EventCandidate를 생성하지 않는다.

---

## 7. 설계 의사결정 근거

**왜 Trigger 위치 기준으로 Subject를 배정하는가?**
금융 뉴스에서 기업명과 이벤트 트리거는 대부분 같은 문장 또는 인접 문장에 등장한다. 문서 전체에서 최빈 기업을 subject로 쓰면 단순 언급과 실제 주체를 혼동할 위험이 있다. 거리 기반 배정은 단순하면서도 정밀도가 높다.

**왜 factuality와 certainty를 분리하는가?**
factuality는 "이 정보가 사실인가/해석인가"를 나타내고, certainty는 "이 이벤트가 얼마나 확정된 상태인가"를 나타낸다. 에이전트의 Risk Controller가 "확정과 가능성을 구분"하는 규칙을 적용하려면 이 두 속성이 독립적으로 관리되어야 한다.
