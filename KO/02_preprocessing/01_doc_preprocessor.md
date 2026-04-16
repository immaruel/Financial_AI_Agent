# 01. 문서 전처리 (Document Preprocessor)

## 1. 목적

`CanonicalDocument`를 후속 NLP 처리가 가능한 공통 포맷으로 변환한다. 구체적으로는 본문을 문장 단위로 분리하고, 문서 서브타입을 분류하여 `PreprocessedDocument`를 생성한다.

이 단계는 STEP 2(문서 전처리)의 입구로, 이후 NER·이벤트 추출 등 모든 전처리 모듈이 이 출력을 입력으로 사용한다.

---

## 2. 입력 / 출력

### 입력

`CanonicalDocument` 리스트 (document_fingerprint.py 출력, doc_status="active"인 문서만)

### 출력

`PreprocessedDocument` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `canonical_doc_id` | str | 원본 문서 ID (CanonicalDocument와 동일) |
| `source_type` | SourceType | `filing` / `news` |
| `title_text` | str | 정제된 제목 |
| `sentences` | List[Sentence] | 분리된 문장 목록 |
| `doc_subtype` | str | 문서 서브타입 (예: `earnings`, `company_event`) |
| `doc_parse_meta` | Dict | 파싱 메타데이터 |
| `published_at` | datetime | 게시 시각 |

`Sentence` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `sentence_id` | str | `{canonical_doc_id}_s{index}` |
| `text` | str | 문장 원문 |
| `char_start` | int | 원문 내 시작 오프셋 |
| `char_end` | int | 원문 내 종료 오프셋 |

---

## 3. 처리 로직

### 3.1 문장 분리

`source_type`에 따라 분리 전략이 다르다.

**뉴스 문장 분리:**

한국어 종결어미 기반 규칙을 사용한다. 마침표(`.`), 다(`다.`), 함(`함.`), 됨(`됨.`), 임(`임.`) 등의 패턴으로 문장을 분리한다.

**공시 문장 분리:**

공시는 항목형 구조(`번호 목록`, `항목명: 값`)를 인식하여, 구조 단위로 세그먼트를 나눈다. 일반 서술 문장과 구조화 항목을 구분하여 처리한다.

**문장 길이 필터:**

```python
min_sentence_length = 5    # 5자 미만 문장 제거
max_sentence_length = 500  # 500자 초과 문장은 분할 처리
```

### 3.2 문서 서브타입 분류

`normalized_text`와 `title` 내 키워드를 기반으로 문서의 세부 유형을 분류한다. 키워드 매칭 순서대로 첫 번째 매칭된 서브타입이 확정된다.

**공시 서브타입:**

| 서브타입 | 키워드 |
|----------|--------|
| `earnings` | 영업이익, 매출액, 순이익, 실적, 분기보고서 |
| `contract` | 공급계약, 수주, 납품, 계약체결 |
| `dividend` | 배당, 현금배당, 주당배당금 |
| `buyback` | 자사주, 자기주식, 취득 |
| `mna` | 인수, 합병, 지분취득, 경영권 |
| `capital` | 유상증자, 무상증자, 전환사채, 신주 |
| `regulation` | 행정처분, 과징금, 시정명령, 제재 |

**뉴스 서브타입:**

| 서브타입 | 키워드 |
|----------|--------|
| `company_event` | 계약, 수주, 실적, 공시, 발표 |
| `industry_trend` | 산업, 시장, 트렌드, 전망, 성장 |
| `policy` | 정책, 규제, 법안, 정부, 제도 |
| `macro` | 금리, 환율, 물가, GDP, 고용 |

`doc_subtype`은 이후 이벤트 추출에서 trigger lexicon 선택과 confidence 보정에 사용된다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- `document_fingerprint.py` → `CanonicalDocument` 리스트

### Downstream
- `ner_extractor.py` → `PreprocessedDocument`의 `sentences`를 입력으로 사용
- `event_extractor.py` → `doc_subtype`을 이벤트 프레임 생성 시 참조

### 외부 의존성
- Python `re`: 문장 분리 패턴
- `PreprocessingConfig` (config/settings.py): 문장 길이 임계값, 서브타입 키워드 사전

---

## 5. 데이터 흐름 내 위치

```
[Document Fingerprinting]
        │  CanonicalDocument (doc_status="active")
        ▼
[Document Preprocessor]   ← 이 문서
        │  PreprocessedDocument
        ├──→ [NER Extractor]          (sentences 입력)
        ├──→ [Event Extractor]        (doc_subtype 참조)
        └──→ [Graph Loader]           (passage 구성 시 참조)
```

---

## 6. 구현 기준 설계

### 배치 처리

`preprocess_batch(canonical_docs: List[CanonicalDocument])` 메서드로 문서 목록 전체를 일괄 처리한다. 내부적으로 각 문서를 순차 처리하며, 문서 수가 증가할 경우 Ray Actor 기반 병렬 처리로 전환 가능하도록 설계되어 있다.

### sentence_id 규칙

```python
sentence_id = f"{canonical_doc_id}_s{index}"
```

이 ID는 이후 `MentionSpan`, `EvidenceSpan`, `PassageRecord`에서 문장과의 연결 키로 사용된다.

### title_text 별도 보존

`title_text`는 본문 문장과 별도로 유지된다. NER 추출 시 제목도 독립적으로 처리되며, 공시 제목에는 이벤트 트리거 표현이 집중되는 경향이 있어 별도 처리가 효과적이다.

---

## 7. 설계 의사결정 근거

**왜 문장 분리를 ML 모델이 아닌 규칙 기반으로 하는가?**
금융 공시와 뉴스는 도메인 어휘와 구조가 예측 가능하다. 종결어미 기반 규칙은 속도가 빠르고 결과가 일관되며, 파라미터(`min/max_sentence_length`)로 품질 조정이 가능하다. 문장 분리 오류는 이후 NER confidence로 흡수된다.

**왜 서브타입 분류를 이 단계에서 하는가?**
이벤트 추출 단계에서 trigger lexicon의 우선순위와 confidence 가중치를 문서 유형에 따라 다르게 적용해야 한다. 예를 들어 `earnings` 서브타입 공시에서 "매출" 언급의 confidence는 `policy` 뉴스에서의 "매출" 언급보다 높게 설정된다.
