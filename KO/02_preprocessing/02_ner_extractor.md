# 02. 엔티티 후보 추출 (NER Extractor)

## 1. 목적

`PreprocessedDocument`의 각 문장에서 KG 적재 후보가 될 **mention span**을 최대한 폭넓게 추출한다.

이 단계는 **recall 우선** 전략을 채택한다. 잘못 추출된 mention은 이후 타입 분류·Entity Resolution 단계에서 필터링되므로, 누락 없이 최대한 많은 후보를 확보하는 것이 목표다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `PreprocessedDocument` 리스트 | 문장 분리 완료 문서 |
| `ReferenceDataManager` | 상장사·산업·기관·지역·원자재 사전 |
| `NERConfig` | 엔티티 길이 임계값, 패턴 정의 |

### 출력

`Dict[canonical_doc_id, List[MentionSpan]]`

`MentionSpan` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `mention_id` | str | UUID (prefix: `men_`) |
| `mention_text` | str | 추출된 텍스트 |
| `sentence_id` | str | 출처 문장 ID |
| `char_start` | int | 문장 내 시작 오프셋 |
| `char_end` | int | 문장 내 종료 오프셋 |
| `mention_source` | str | 추출 방법 식별자 |
| `ner_confidence` | float | 추출 confidence (0.0~1.0) |

---

## 3. 처리 로직

4가지 전략을 순서대로 적용하며, 중복 span은 오프셋 기준으로 제거한다.

### 전략 1: 레퍼런스 사전 매칭 (Dictionary Matcher)

`ReferenceDataManager`로부터 아래 5개 사전을 로드한다.

| 사전 | 소스 |
|------|------|
| 상장사 명칭 + 별칭 | DART 전체 상장사 |
| 산업 명칭 | 외부 산업 분류표 |
| 기관 명칭 | 기관 reference data |
| 지역 명칭 | 지역/국가 reference data |
| 원자재 명칭 | commodity reference data |

**긴 문자열 우선 매칭**: 사전 항목을 문자열 길이 내림차순으로 정렬하여 매칭한다. 예를 들어 "현대자동차그룹"이 "현대자동차"보다 먼저 매칭되어, 짧은 별칭이 내부에서 중복 매칭되는 문제를 방지한다.

```python
self._all_dict_entries.sort(key=lambda item: len(item[0]), reverse=True)
```

`mention_source = "dictionary_match"`, `ner_confidence = 0.85`

### 전략 2: 정형값 Rule Parser

정규식 기반으로 금액·날짜·퍼센트를 추출한다.

**금액 패턴:**
```python
r"(\d[\d,]*\.?\d*)\s*(원|억원|만원|조원|천원|달러|USD|EUR|JPY|CNY)"
r"(약\s*)?\d[\d,]*\.?\d*\s*(억|조|만)\s*원"
```

**날짜 패턴:**
```python
r"\d{4}[년./-]\s*\d{1,2}[월./-]\s*\d{1,2}[일]?"
r"\d{4}[년.]\s*\d{1,2}[월.]"
r"(?:올해|내년|작년|금년)\s*\d{1,2}[월]"
```

**퍼센트 패턴:**
```python
r"(\d+\.?\d*)\s*%"
```

`mention_source = "rule_parser"`, `ner_confidence = 0.90`

### 전략 3: 이벤트 Trigger Lexicon

14개 이벤트 타입별 trigger 표현을 사전으로 정의하여, 해당 단어가 문장에 등장하면 mention으로 추출한다.

| 이벤트 타입 | 주요 트리거 |
|-------------|------------|
| `ContractEvent` | 계약, 수주, 공급계약, 체결, 협약, MOU, 파트너십, 합작 |
| `EarningsEvent` | 실적, 매출, 영업이익, 순이익, 적자, 흑자전환, 판매, 수출 |
| `CorporateAction` | 출시, 발표, 투자, 증설, 양산, 전기차, EV, 자율주행 |
| `DividendEvent` | 배당, 현금배당, 중간배당, 기말배당 |
| `BuybackEvent` | 자사주, 자기주식취득, 소각 |
| `M&AEvent` | 인수, 합병, 지분취득, 피인수, 경영권 |
| `RatingChange` | 등급, 신용등급, 상향, 하향, 등급조정 |
| `PolicyAnnouncement` | 정책, 법안, 규제, 시행, 보조금, 세제, 육성 |
| `RegulationEvent` | 제재, 과징금, 행정처분, 시정명령, 리콜명령 |
| `SupplyDisruption` | 공급차질, 생산중단, 가동중단, 리콜, 부품부족 |
| `MacroRelease` | 금리, 기준금리, 환율, GDP, CPI, 관세 |
| `LawsuitEvent` | 소송, 손해배상, 법적분쟁, 판결, 특허소송 |
| `GuidanceChange` | 가이던스, 전망, 목표, 하향조정, 상향조정 |
| `ManagementChange` | 대표이사, CEO, 임원, 선임, 사임, 조직개편 |
| `LaborEvent` | 파업, 노조, 노사, 단체교섭, 임금협상 |

`mention_source = "trigger_lexicon"`, `ner_confidence = 0.70`

### 전략 4: Counterparty Placeholder 패턴

"A사", "B그룹", "협력사", "거래처" 등 실제 기업명이 명시되지 않은 표현을 Placeholder 후보로 추출한다.

`mention_source = "placeholder_pattern"`, `ner_confidence = 0.50`

---

## 4. 의존성 및 연계 모듈

### Upstream
- `doc_preprocessor.py` → `PreprocessedDocument` (sentences 포함)
- `reference/company_data.py` → 5개 도메인 사전

### Downstream
- `entity_type_classifier.py` → `MentionSpan` + 문맥을 받아 타입 확정
- `event_extractor.py` → trigger_lexicon 기반 mention이 이벤트 트리거로 활용됨

### 외부 의존성
- `NERConfig` (config/settings.py): `min_entity_length=2`, `max_entity_length=30`, confidence 임계값
- Python `re`: 정형값 패턴 컴파일

---

## 5. 데이터 흐름 내 위치

```
[Document Preprocessor]
        │  PreprocessedDocument (sentences)
        ▼
[NER Extractor]   ← 이 문서
        │  Dict[doc_id, List[MentionSpan]]
        ▼
[Entity Type Classifier]
```

---

## 6. 구현 기준 설계

### 사전 초기화 (생성자에서 1회 실행)

```python
def __init__(self, config: NERConfig, ref_data: ReferenceDataManager):
    # 5개 사전 통합 + 길이 내림차순 정렬
    self._all_dict_entries = []
    for name in ref_data.get_all_company_names():
        self._all_dict_entries.append((name, "Company"))
    # ... Industry, Institution, Region, Commodity 추가
    self._all_dict_entries.sort(key=lambda item: len(item[0]), reverse=True)

    # 정형값 패턴 사전 컴파일 (1회)
    self._money_patterns = [re.compile(p) for p in config.money_patterns]
    self._date_patterns  = [re.compile(p) for p in config.date_patterns]
    self._pct_pattern    = re.compile(r"(\d+\.?\d*)\s*%")
```

### 중복 span 제거

동일 문장 내에서 오프셋이 겹치는 mention은 confidence가 높은 것을 유지한다.

### 배치 처리

`extract_batch(preprocessed_docs)` → `Dict[canonical_doc_id, List[MentionSpan]]`

---

## 7. 설계 의사결정 근거

**왜 ML NER 모델을 사용하지 않는가?**
DART 전체 상장사(2,500개+) 명칭은 사전으로 완전히 커버 가능하다. ML 모델은 추론 비용이 크고 도메인 어휘 추가 시 재학습이 필요하다. 사전 기반 매칭은 결정론적이고 빠르며, 새 기업 등록 시 사전 갱신만으로 즉시 반영된다.

**왜 recall 우선인가?**
이 단계의 오탐(false positive)은 타입 분류·Entity Resolution에서 낮은 confidence로 필터링된다. 반면 누락(false negative)은 이후 단계에서 복구할 수 없다. NER confidence 임계값(`ner_confidence_threshold=0.5`)을 낮게 설정하여 최대한 넓게 수집한다.
