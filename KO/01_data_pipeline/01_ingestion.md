# 01. 문서 수집 (Document Ingestion)

## 1. 목적

외부 소스(DART 공시 API, 네이버 뉴스 API)로부터 금융 문서를 수집하여 `RawDocument` 형태로 저장한다.

> **원문 보존 범위**: source별 connector는 본문을 단순 text로 평탄화하지 않고, 원본 artifact(ZIP/XML/HTML/PDF)와 paragraph/table/figure/caption block, 그리고 페이지·DOM 위치를 함께 보존한다. block과 EvidenceBlock의 관계는 [Retrieval Worker와 EvidenceBlock](../04_agent_system/03_retrieval_workers.md#2-공통-근거-단위-evidenceblock)을 따른다. 이는 KPI 추출·백필 플랫폼을 구현하는 범위가 아니라, 금융 답변의 원문 citation을 보존하는 범위다.

단순 다운로드가 아니라 **출처·시간·정정 이력·중복 여부를 정확히 추적하는 것**이 이 모듈의 핵심 목적이다. 후속 전처리 파이프라인이 신뢰할 수 있는 원문 메타데이터를 보장하는 첫 번째 게이트다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `CollectionConfig` | polling 주기, lookback 기간, API 키, 검색 키워드 등 수집 파라미터 전체 |
| DART API 엔드포인트 | `https://opendart.fss.or.kr/api` |
| Naver 뉴스 API 엔드포인트 | `https://openapi.naver.com/v1/search/news.json` |
| `company_names` | DART 전체 상장사 명칭 목록 (뉴스 키워드 기반 수집에 사용) |

### 출력

`RawDocument` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `raw_doc_id` | str | 내부 UUID (prefix: `raw_`) |
| `source_type` | SourceType | `filing` / `news` |
| `source_url` | str | 원문 URL |
| `external_doc_id` | str | 소스 고유 ID (공시 접수번호 / 뉴스 링크) |
| `original_title` | str | 원문 제목 |
| `raw_text` | str | 정제 전 본문 |
| `original_timestamp` | datetime | 원문 게시 시각 |
| `crawled_at` | datetime | 수집 실행 시각 |
| `rcept_no` | str (공시) | DART 접수번호 |
| `corp_code` | str (공시) | DART 법인코드 |
| `is_correction` | bool (공시) | 정정 공시 여부 |
| `parent_rcept_no` | str (공시) | 정정 대상 원본 접수번호 |

목표 출력은 `RawDocument.raw_text`만으로 충분하지 않다. `RawArtifact`(원본 ZIP/XML/HTML/PDF, hash, mime type, fetch time)와 `DocumentBlock`(paragraph/table/table_cell/figure/caption, order, locator)을 별도로 저장하고, 정규화 text는 파생 산출물로 유지한다.

---

## 3. 처리 로직

### 3.1 CollectionOrchestrator

`source_connector.py`의 최상위 오케스트레이터. `DARTFilingConnector`와 `NaverNewsConnector`를 병렬 실행하고 결과를 합산한다.

```python
class CollectionOrchestrator:
    async def collect_all(self) -> List[RawDocument]:
        # DARTFilingConnector, NaverNewsConnector 동시 실행
        results = await asyncio.gather(
            dart_connector.fetch_documents(),
            news_connector.fetch_documents(),
        )
        return flatten(results)
```

### 3.2 DART 공시 수집 (`DARTFilingConnector`)

**수집 흐름:**

```
list.json 페이지네이션 (bgn_de ~ end_de, PAGE_SIZE=100)
      │
      ▼
공시 목록 전체 확보 (filing_list)
      │
      ▼
asyncio.gather + Semaphore(max_concurrent=10)
  └─ 각 공시별 _fetch_single_filing() 병렬 실행
      │
      ├─ FULL_TEXT_REPORT_TYPES 해당 시 → 원문 파일(document.xml) archive 추가 수집
      └─ 나머지 → 제목/메타만 유지
```

**FULL_TEXT_REPORT_TYPES (본문까지 수집하는 공시 유형):**
```
주요사항보고서, 실적공시, 공급계약체결, 유상증자, 자기주식,
배당, 합병, 분할, 영업양수도, 주식교환, 대규모내부거래, 임원변동
```

`document.xml`은 XML을 문자열로 가정해 처리하지 않는다. OpenDART 원문 파일 API의 응답은 ZIP archive이므로 bytes로 저장·검증한 뒤 내부 XML/XHTML을 DOM parser로 block화한다. 표의 header, 행/열, 병합 셀, 단위·통화·기간 문맥과 section/XPath/table locator를 보존한다.

**정정 공시 처리:**
- 제목에 정정 키워드(`정정`, `[정정]`, `기재정정` 등) 포함 시 `is_correction=True`
- `parent_rcept_no`에 원본 접수번호 연결
- 접수번호가 다르면 항상 별개의 `RawDocument`로 저장

**시간 파라미터:**

| 파라미터 | 기본값 | 설명 |
|----------|--------|------|
| `filing_lookback_days` | 3일 | 매 실행 시 과거 3일 재조회 |
| `filing_poll_interval_sec` | 300초 (5분) | 새 공시 체크 주기 |
| `filing_update_window_days` | 3일 | 기존 공시 수정 허용 기간 |

### 3.3 네이버 뉴스 수집 (`NaverNewsConnector`)

**수집 흐름:**

```
news_search_keywords (기본: 현대자동차, 삼성전자 등 10개)
      │
      ▼
키워드별 API 호출 (display=news_display_count, 기본 100건)
      │
      ▼
asyncio.gather + Semaphore 병렬 처리
      │
      ▼
발행사 원문 HTML/PDF의 DOM 기반 block 추출 (source_url 기반, 접근 허용 시)
      │
      ▼
RawDocument 생성
```

**시간 파라미터:**

| 파라미터 | 기본값 | 설명 |
|----------|--------|------|
| `news_lookback_hours` | 24시간 | 매 실행 시 과거 24시간 재조회 |
| `news_poll_interval_sec` | 600초 (10분) | 새 뉴스 체크 주기 |
| `news_update_window_days` | 3일 | 기존 뉴스 수정 허용 기간 |
| `news_display_count` | 100 | 키워드당 최대 수집 건수 (API 상한) |

---

## 4. 의존성 및 연계 모듈

### Upstream
- `ReferenceDataManager` (reference/company_data.py): DART 전체 상장사 목록 제공 → 뉴스 수집 키워드 및 NER 사전의 기반
- `CollectionConfig` (config/settings.py): 모든 수집 파라미터

### Downstream
- `RawDocumentNormalizer` (collection/raw_normalizer.py): 수집된 RawDocument와 block text를 공통 포맷으로 정규화
- `DocumentFingerprinter` (collection/document_fingerprint.py): 중복/버전 판별

### 외부 의존성
- `aiohttp`: 비동기 HTTP 클라이언트
- `asyncio.Semaphore`: 동시 요청 수 제어 (`max_concurrent_requests=10`)

---

## 5. 데이터 흐름 내 위치

```
[외부 API] ──→ [Source Connector] ──→ [Raw Document Normalizer] ──→ [Document Fingerprinter]
                     ↑
              (이 문서가 다루는 모듈)
```

STEP 1의 첫 번째 단계. 외부 세계와 내부 파이프라인 사이의 경계다.

---

## 6. 구현 기준 설계

### 비동기 처리 구조

네트워크 I/O가 병목이므로 모든 HTTP 요청은 `aiohttp` + `asyncio.gather`로 처리한다. CPU 연산이 없으므로 Ray를 적용하지 않는다.

```python
async with aiohttp.ClientSession() as session:
    semaphore = asyncio.Semaphore(self.config.max_concurrent_requests)
    tasks = [self._fetch_single_filing(session, item, semaphore) for item in filing_list]
    results = await asyncio.gather(*tasks, return_exceptions=True)
```

`return_exceptions=True`로 개별 실패가 전체 수집을 중단하지 않도록 한다.

### 시간 정보 다중 보존

금융 도메인에서 시간은 복수의 의미를 가진다.

| 필드 | 의미 |
|------|------|
| `published_at` | 문서가 게시된 시각 |
| `updated_at` | 문서가 수정된 시각 |
| `effective_at` | 실제 효력 발생 시각 (공시의 경우 중요) |
| `crawled_at` | 수집 실행 시각 |
| `first_seen_at` | 시스템이 최초로 본 시각 |

이 필드들은 이후 Event Canonicalization 및 에이전트의 시간 필터링에서 참조된다.

### 출처 신뢰도 계층 (trust_tier)

수집 시점에 `source_type`에 따라 `trust_tier`가 결정된다.

| trust_tier | 소스 유형 |
|------------|-----------|
| 1 | filing, exchange_notice, government |
| 2 | ir, official_release |
| 3 | news |
| 4 | analysis |
| 5 | rumor |

이 값은 이후 Event Canonicalization에서 대표값 결정 우선순위로 사용된다.

### KG Miss 시 실시간 보완 수집

`main.py`의 `_online_supplement()` 메서드에서 이 모듈을 직접 재호출한다. 이 때 `news_search_keywords`를 질의 키워드로 임시 교체하고, 수집 건수를 20건으로 제한하여 빠른 보완이 가능하도록 한다.

목표 구조에서 online supplement는 단순 text 수집으로 원문 artifact를 덮어쓰지 않는다. 모든 수집 결과는 content hash, source URL, fetch time과 함께 별도 artifact로 저장하며, connector 실패는 `parse_failed` 또는 `access_denied` 상태로 Supervisor에 전달한다.

---

## 7. 설계 의사결정 근거

**왜 DART 공시를 페이지네이션으로 전체 수집하는가?**
최신 100건 목록만 가져오는 방식은 고빈도 공시 기간에 누락이 발생할 수 있다. `bgn_de`~`end_de` 범위를 PAGE_SIZE=100으로 페이지네이션하면 기간 내 전체 공시를 빠짐없이 수집한다.

**왜 네이버 검색 connector와 발행사 connector를 분리하는가?**
네이버 뉴스 API 응답에는 제목과 요약, 기사 링크가 포함된다. 이는 후보 발견에 적합하지만 본문·표·이미지의 표준 형식이 아니다. 실제 원문은 접근이 허용된 발행사 URL에서 DOM 기반으로 파싱하며, 발행사별 정책·selector·저작권 조건을 별도로 관리해야 한다.

**왜 HTML 태그를 정규식으로 제거하지 않는가?**
정규식 평탄화는 문단 순서, 표 셀, figure caption, URL locator를 잃는다. 이후 정확한 수치 검증과 클릭 가능한 citation을 만들 수 없으므로 DOM/XML/PDF parser로 구조를 보존한다.

**왜 정정 공시를 별도 문서로 저장하는가?**
정정 전·후 내용을 모두 보존해야 사실 변경 이력 추적이 가능하다. `parent_rcept_no`로 연결하되 별도 `raw_doc_id`를 부여하여 버전 관계를 명시한다.
