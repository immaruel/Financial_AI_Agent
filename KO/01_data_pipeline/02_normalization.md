# 02. 문서 정규화 및 중복 판별 (Normalization & Fingerprinting)

## 1. 목적

수집된 `RawDocument`를 두 단계로 처리하여 후속 전처리 파이프라인이 사용하는 `CanonicalDocument`를 생성한다.

- **Raw Document Normalization**: 소스별로 상이한 응답 포맷을 내부 공통 스키마로 변환하고, 텍스트를 정제한다.
- **Document Fingerprinting**: 정규화된 문서의 중복·버전·정정 여부를 판별하고 대표 문서(`CanonicalDocument`)를 확정한다.

이 두 단계는 **1차 중복 제거 계층**으로, 이후 Event Canonicalization(3차 중복 제거)과 함께 시스템의 중복 제거 체계를 구성한다.

---

## 2. 입력 / 출력

### 입력

`RawDocument` 리스트 (source_connector.py 출력)

### 출력

`CanonicalDocument` (utils/schemas.py)

| 필드 | 타입 | 설명 |
|------|------|------|
| `canonical_doc_id` | str | 내부 UUID (prefix: `canon_`) |
| `source_type` | SourceType | `filing` / `news` |
| `trust_tier` | int | 출처 신뢰도 (1~5) |
| `title` | str | 정제된 제목 |
| `normalized_text` | str | 정제된 본문 |
| `published_at` | datetime | 게시 시각 |
| `updated_at` | datetime | 수정 시각 |
| `source_url` | str | 원문 URL |
| `external_doc_id` | str | 소스 고유 ID |
| `doc_status` | DocStatus | `active` / `superseded` / `duplicate` |
| `parent_doc_id` | str | 정정 대상 원본 문서 ID |
| `dedup_group_id` | str | 중복 그룹 식별자 |
| `document_class` | str | 문서 분류 (subtype) |
| `rcept_no` | str | 공시 접수번호 (공시 전용) |

---

## 3. 처리 로직

### 3.1 Raw Document Normalization (`raw_normalizer.py`)

정규화는 `source_type`에 따라 분기된다.

**공통 처리:**
1. HTML 태그 제거
2. Unicode normalization (NFC)
3. 연속 공백 / 줄바꿈 정리
4. `crawled_at`, `first_seen_at` 타임스탬프 확정

**뉴스 전용 처리:**

Boilerplate 제거 패턴을 정규식으로 순차 적용한다.

```python
news_boilerplate_patterns = [
    r"©.*?(?:무단|재배포)",           # 저작권 표시
    r"기자\s*[가-힣]{2,4}\s*[a-zA-Z0-9_.+-]+@",  # 기자 이메일
    r"\[.*?뉴스.*?\]",               # 언론사 태그
    r"▶.*?(?:관련기사|더보기)",       # 관련기사 링크
]
```

**공시 전용 처리:**
- `is_correction=True`인 경우 `parent_rcept_no`를 메타에 보존
- XML 구조의 항목형 데이터는 key-value 형식으로 변환

### 3.2 Document Fingerprinting (`document_fingerprint.py`)

중복 판별은 `source_type`에 따라 전략이 다르다.

**공시 중복 판별:**

```
동일 rcept_no → exact_duplicate → doc_status = "duplicate"
정정 공시(is_correction=True) → doc_status = "active"
                               + parent_doc_id 연결
                               + 원본 doc_status = "superseded"
```

공시는 `rcept_no`가 핵심 키다. 같은 접수번호가 재입력되면 중복으로 처리하고, 정정 공시는 새 canonical_doc_id를 부여하되 원본과 parent 관계를 설정한다.

**뉴스 중복 판별 (2단계):**

```
1단계: 정확 해시 매칭
   SHA-256(normalize(title + body)) 동일 → exact_duplicate

2단계: SimHash 기반 near-duplicate 탐지
   SimHash Hamming distance ≤ simhash_distance_threshold(기본: 5)
   → near_duplicate 후보

3단계: Jaccard 유사도 확인
   Jaccard(token_set_A, token_set_B) ≥ 0.80
   → near_duplicate 확정 → 대표 문서 1개 선정, 나머지 doc_status = "duplicate"
```

**대표 문서 선정 기준 (near-duplicate 그룹에서):**
1. `trust_tier`가 낮은 문서 우선 (공시 > 뉴스)
2. 동일 tier 내에서는 `published_at`이 가장 이른 문서

---

## 4. 의존성 및 연계 모듈

### Upstream
- `source_connector.py` → `RawDocument` 리스트 제공

### Downstream
- `doc_preprocessor.py` → `CanonicalDocument`를 받아 문장 분리 수행
- `step1_checkpoint.py` → 처리 결과를 JSON 체크포인트로 저장

### 외부 의존성
- `xxhash64`: 고속 정확 해시 (exact_hash_algorithm 설정값)
- SimHash 구현체: near-duplicate 탐지
- Python `re`: Boilerplate 패턴 제거

---

## 5. 데이터 흐름 내 위치

```
[Source Connector]
        │  RawDocument
        ▼
[Raw Document Normalization]   ← 이 문서 (정규화)
        │  정제된 RawDocument
        ▼
[Document Fingerprinting]      ← 이 문서 (중복 판별)
        │  CanonicalDocument
        ▼
[STEP 1 Checkpoint]            ← step1_checkpoint.json 저장
        │
        ▼
[Document Preprocessor]        → STEP 2 진입
```

---

## 6. 구현 기준 설계

### STEP 1 체크포인트

`step1_checkpoint.py`는 STEP 1 완료 후 `CanonicalDocument` 리스트를 JSON으로 직렬화·저장한다. STEP 2~4는 이 체크포인트를 로드하여 수집 단계를 재실행하지 않고 시작할 수 있다.

```python
# 저장
save_step1(active_docs, DEFAULT_STEP1_PATH)

# 로드
active_docs = load_step1(DEFAULT_STEP1_PATH)
```

### doc_status 상태 전이

```
RawDocument 수집
      │
      ├─ 신규 문서 → CanonicalDocument(doc_status="active")
      │
      ├─ 정확 중복 → doc_status="duplicate"
      │
      ├─ 정정 공시 → 신규: doc_status="active"
      │              원본: doc_status="superseded"
      │
      └─ near-duplicate → 대표: doc_status="active"
                          나머지: doc_status="duplicate"
```

후속 파이프라인은 `doc_status == "active"`인 문서만 처리한다.

```python
active_docs = [d for d in canonical_docs if d.doc_status.value == "active"]
```

### 시간 정보 다중 유지

공시와 뉴스는 시간 의미가 다르므로, 수집 단계의 5개 시간 필드를 모두 `CanonicalDocument`에 보존한다. 에이전트의 시간 필터링(`time_constraints`)은 주로 `published_at`을 기준으로 하되, 공시의 경우 `effective_at`을 우선한다.

---

## 7. 설계 의사결정 근거

**왜 공시와 뉴스의 중복 판별 전략을 분리하는가?**
공시는 `rcept_no`라는 명확한 외부 식별자가 있으므로 해시 기반 중복 판별이 불필요하다. 반면 뉴스는 동일 사건을 다수 매체가 보도하고 기사가 수정·재배포되므로, SimHash + Jaccard 조합이 필요하다. 두 전략을 혼용하면 공시의 정정 이력이 중복으로 오분류될 위험이 있다.

**왜 near-duplicate와 event-level 중복을 분리하는가?**
근거는 `document_fingerprint.py` 주석에도 명시되어 있다. 같은 사건을 다룬 다른 언론사의 기사는 내용이 유사해도 서로 다른 증거(evidence)로서 가치를 가진다. 문서 단위 near-duplicate 제거와 이벤트 단위 중복 병합(Event Canonicalization)은 별개의 목적이므로 단계를 분리한다.
