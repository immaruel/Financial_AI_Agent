# 01. 온톨로지 정의 (Ontology)

## 1. 목적

금융 도메인의 핵심 개체와 관계를 **정적 지식과 동적 이벤트로 분리**하여 정의한다. 이 온톨로지는 KG에 어떤 노드와 엣지가 존재할 수 있는지를 규정하며, 전처리 파이프라인의 추출 결과를 그래프 구조로 변환하는 기준이 된다.

설계 참조: FIBO(Financial Industry Business Ontology)의 핵심 개념을 금융 이벤트 분석 목적에 맞게 재정의.

하네스 엔지니어링 관점에서 온톨로지는 단순한 개념도 정의가 아니라, **Constraint Layer와 Context Layer의 핵심 기준 파일**이다. 즉, 어떤 노드/엣지가 허용되는지뿐 아니라 어떤 조합이 금지되는지, 어떤 검증이 필요한지를 결정한다.

---

## 2. 전체 구조

```
┌──────────────────────────────────────────────────────┐
│                   정적 개체 레이어                     │
│                                                      │
│  Company  Industry  Region  Institution  Commodity   │
└──────────────────────────────────────────────────────┘
                         │
              구조 관계 엣지 (BELONGS_TO, SUPPLIES_TO 등)
                         │
┌──────────────────────────────────────────────────────┐
│                   동적 사건 레이어                     │
│                                                      │
│                     Event                            │
│  (ContractEvent, EarningsEvent, M&AEvent, ...)       │
└──────────────────────────────────────────────────────┘
                         │
              근거 관계 엣지 (SUPPORTED_BY, FROM_DOCUMENT 등)
                         │
┌──────────────────────────────────────────────────────┐
│                   증거/출처 레이어                     │
│                                                      │
│              Evidence          Document              │
└──────────────────────────────────────────────────────┘
```

정적 레이어는 기업의 구조적 맥락을 제공하고, 동적 레이어는 시간에 따라 누적되는 사건을 담는다. 증거 레이어는 모든 주장의 근거를 원문과 연결한다.

---

## 3. 노드 정의

### 3.1 정적 개체 레이어

#### Company
기업 Entity Resolution 결과의 canonical entity. KG에서 가장 중심적인 노드 타입이다.

| 속성 | 필수 | 설명 |
|------|------|------|
| `canonical_entity_id` | ✓ | 전체 시스템 고유 키 |
| `name` | ✓ | 공식 기업명 |
| `ticker` | | 종목코드 |
| `corp_code` | | DART 법인코드 |
| `exchange` | | 상장 거래소 |
| `country` | | 소재 국가 |

소스: Entity Resolution 결과 + DART reference data

#### Industry
기업의 산업 소속. 산업 분류 reference data 기반으로 적재된다. 기사 문맥만으로 추정된 산업은 적재하지 않는다.

| 속성 | 필수 | 설명 |
|------|------|------|
| `industry_id` | ✓ | 산업 분류 ID |
| `name` | ✓ | 산업명 |
| `taxonomy_source` | | 분류 기준 출처 |

#### Region
기업의 지역 노출 또는 이벤트의 지리적 범위. 주로 `EXPOSED_TO_REGION` 엣지로 Company와 연결된다.

#### Institution
정부기관, 중앙은행, 규제기관, 금융기관 등.

#### Commodity
기업이 생산하거나 사용하는 원자재·상품. `USES_COMMODITY`, `PRODUCES` 엣지로 Company와 연결된다.

---

### 3.2 동적 사건 레이어

#### Event
Event Canonicalization 결과의 `CanonicalEvent`가 적재된 노드. KG에서 질의의 핵심 단위다.

| 속성 | 필수 | 설명 |
|------|------|------|
| `canonical_event_id` | ✓ | 이벤트 고유 키 |
| `event_type` | ✓ | leaf 이벤트 타입 |
| `event_time` | ✓ | 발생 시각 (없으면 `published_at`으로 대체) |
| `event_subtype` | | 상위 카테고리 |
| `effective_time` | | 효력 발생 시각 |
| `polarity` | | positive / negative / neutral / mixed |
| `certainty` | | disclosed / reported / estimated / speculated |
| `confidence` | | 추출 confidence |

**이벤트 타입 계층:**

```
CorporateAction
  ├── ContractEvent      (계약, 수주, MOU, 파트너십)
  ├── DividendEvent      (배당, 현금배당)
  ├── BuybackEvent       (자사주, 소각)
  ├── M&AEvent           (인수, 합병, 지분취득)
  └── CapitalEvent       (유상증자, 전환사채)

FinancialResult
  ├── EarningsEvent      (매출, 영업이익, 실적)
  ├── GuidanceChange     (가이던스, 전망 수정)
  └── CreditEvent        (신용등급 변동)

ExternalShock
  ├── RegulationEvent    (제재, 과징금, 시정명령)
  ├── PolicyAnnouncement (정책 발표, 보조금)
  ├── MacroRelease       (금리, 환율, GDP)
  └── SupplyDisruption   (공급차질, 생산중단, 리콜)

SpecialEvent
  ├── LawsuitEvent       (소송, 특허 분쟁)
  ├── DelistingRisk      (상장폐지 위험)
  ├── RatingChange       (신용등급 조정)
  ├── ManagementChange   (임원 선임/사임, 조직개편)
  └── LaborEvent         (파업, 노사 분쟁)
```

---

### 3.3 증거/출처 레이어

#### Evidence
이벤트를 뒷받침하는 원문 문장 단위의 span. `event_extractor.py`의 `EvidenceSpan`이 적재된다.

| 속성 | 필수 | 설명 |
|------|------|------|
| `evidence_id` | ✓ | 고유 키 |
| `text` | ✓ | 원문 텍스트 |
| `canonical_doc_id` | | 출처 문서 ID |
| `sentence_id` | | 출처 문장 ID |
| `char_start` / `char_end` | | 원문 내 오프셋 |
| `extraction_method` | | 추출 방법 |
| `confidence` | | 추출 confidence |

#### Document
`CanonicalDocument`가 적재된 노드. Evidence와 FROM_DOCUMENT 엣지로 연결된다.

---

## 4. 엣지 정의

### 구조 관계 (정적)

| 엣지 타입 | 소스 | 타깃 | 생성 조건 |
|-----------|------|------|-----------|
| `BELONGS_TO_INDUSTRY` | Company | Industry | reference data 기반 매핑 |
| `LISTED_ON` | Company | Region | 거래소 소재지 |
| `SUBSIDIARY_OF` | Company | Company | 지배구조 데이터 |
| `SUPPLIES_TO` | Company | Company | 공급망 evidence 누적 |
| `EXPOSED_TO_REGION` | Company | Region | 지역 노출 근거 |
| `USES_COMMODITY` | Company | Commodity | 원자재 의존 근거 |

### 이벤트 관계 (동적)

| 엣지 타입 | 소스 | 타깃 | 생성 조건 |
|-----------|------|------|-----------|
| `HAS_EVENT` | Company | Event | `canonical_event.subject_entity_id` 기준 |
| `HAS_EVENT_CANDIDATE` | Company | EventCandidate | canonicalization 전 후보 단계 |
| `INVOLVES` | Event | Company/Institution/Region/Commodity | object/related slot 존재 |
| `AFFECTS` | Event | Company/Industry | 영향 대상 추론/추출 |
| `PRECEDES` | Event | Event | 시간 선후 + 동일 기업/사건군 |
| `CAUSED_BY` | Event | Event | 인과 근거 충분 시 |
| `CANONICALIZED_TO` | EventCandidate | Event | Canonicalization 결과 |

### 근거/검증 관계

| 엣지 타입 | 소스 | 타깃 | 생성 조건 |
|-----------|------|------|-----------|
| `SUPPORTED_BY` | Event | Evidence | evidence span 존재 |
| `FROM_DOCUMENT` | Evidence | Document | 문서 정렬 완료 |
| `DISCLOSED_IN` | Event | Document | source_type == "filing" |
| `REPORTED_IN` | Event | Document | source_type == "news" |
| `OBSERVED_IN` | EventCandidate | Document | 후보 단계 문서 연결 |

---

## 5. 핵심 관계 패턴

금융 분석에서 가장 자주 탐색되는 경로:

```cypher
-- 기업의 최근 이벤트 조회
(Company)-[:HAS_EVENT]->(Event)

-- 이벤트의 원문 근거 회수
(Event)-[:SUPPORTED_BY]->(Evidence)-[:FROM_DOCUMENT]->(Document)

-- 이벤트 간 시간 연쇄
(Event1)-[:PRECEDES]->(Event2)-[:PRECEDES]->(Event3)

-- 산업 내 기업 스크리닝
(Company)-[:BELONGS_TO_INDUSTRY]->(Industry)

-- 정책 영향 분석
(Policy)-[:AFFECTS]->(Industry)<-[:BELONGS_TO_INDUSTRY]-(Company)
```

---

## 6. 설계 의사결정 근거

### 6.1 하네스 관점의 역할

온톨로지는 하네스에서 아래 세 역할을 수행한다.

| 역할 | 설명 |
|------|------|
| Context Layer | planner / retriever / graph loader가 참조하는 공통 의미 체계 |
| Constraint Layer | 허용되지 않은 노드/엣지 조합, 잘못된 귀속, 근거 없는 관계 생성을 차단 |
| Verification Layer | ontology violation count, orphan ratio, stale edge rate의 기준 제공 |

대표 검증 포인트:

- Company 없이 Event만 생성되는가
- Evidence 없는 Event가 과도한가
- PRECEDES / CAUSED_BY가 허용되지 않은 타입 사이에 생성되는가
- Region / Institution / Commodity가 잘못된 edge로 연결되는가

대표 실패 유형:

- F1 엔티티 혼동
- F4 이벤트 귀속 오류
- F5 근거 누락

---

**왜 정적/동적 레이어를 분리하는가?**
기업의 산업 소속(정적)과 기업의 최근 계약 체결(동적)은 질의 패턴과 갱신 주기가 완전히 다르다. 분리하면 빠르게 변하는 이벤트 레이어만 집중적으로 갱신하면서, 안정적인 구조 레이어는 캐시처럼 활용할 수 있다.

**왜 EventCandidate와 CanonicalEvent를 모두 그래프에 유지하는가?**
에이전트는 canonicalized event뿐 아니라 개별 문서 수준의 후보도 참조할 수 있어야 한다. `HAS_EVENT_CANDIDATE` 엣지와 `CANONICALIZED_TO` 엣지를 함께 유지하면, 동일 사건에 대한 복수 보도를 교차 검증하는 Evidence Retriever 기능이 가능하다.
