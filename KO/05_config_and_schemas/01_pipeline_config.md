# 01. 파이프라인 설정 (Pipeline Config)

## 1. 목적

전체 파이프라인의 모든 조정 가능한 파라미터를 `config/settings.py`에서 중앙 관리한다. 각 처리 단계는 해당 Config 인스턴스만 참조하며, 파라미터 변경은 이 파일 한 곳에서 수행한다.

하네스 엔지니어링 관점에서 설정은 단순 threshold 모음이 아니라 다음을 함께 관리하는 기준점이다.

- 어떤 규칙이 현재 활성화되어 있는가
- 어떤 실험 버전으로 평가했는가
- 어떤 게이트를 통과해야 배포 가능한가
- 어떤 컨텍스트 번들을 참조해 에이전트가 동작하는가

즉, 이 문서는 **현재 코드의 Config 구조**와 **향후 하네스 확장 시 함께 관리해야 할 운영 설정**을 함께 정리한다.

---

## 2. 현재 구현의 설정 클래스 구조

`PipelineConfig` 하나가 아래 13개 하위 Config를 포함한다.

```python
@dataclass
class PipelineConfig:
    collection:            CollectionConfig
    normalization:         NormalizationConfig
    preprocessing:         PreprocessingConfig
    ner:                   NERConfig
    entity_typing:         EntityTypingConfig
    entity_resolution:     EntityResolutionConfig
    event_extraction:      EventExtractionConfig
    event_canonicalization: EventCanonicalizationConfig
    neo4j:                 Neo4jConfig
    llm:                   LLMConfig
    embedding:             EmbeddingConfig
    ray:                   RayConfig
    agent:                 AgentConfig
```

이 구조는 **코드가 실제로 참조하는 파라미터 집합**이다.

---

## 3. 단계별 주요 파라미터

### CollectionConfig (문서 수집)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `filing_poll_interval_sec` | 300 | 공시 체크 주기 |
| `news_poll_interval_sec` | 600 | 뉴스 체크 주기 |
| `filing_lookback_days` | 3 | 공시 조회 lookback |
| `news_lookback_hours` | 24 | 뉴스 조회 lookback |
| `dart_api_key` | (하드코딩) | DART API 인증 키 |
| `news_api_key` / `news_api_secret` | (하드코딩) | Naver API 인증 |
| `news_search_keywords` | 10개 기업 | 뉴스 수집 검색 키워드 |
| `news_display_count` | 100 | 키워드당 최대 수집 건수 |
| `max_concurrent_requests` | 10 | 동시 요청 수 |

> **보안 주의**: API 키가 코드에 직접 존재한다. 운영 환경에서는 환경 변수, secret manager, CI 주입 변수로 이관하는 것이 바람직하다.

### NormalizationConfig (정규화)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `simhash_distance_threshold` | 5 | near-duplicate 판정 Hamming distance |
| `near_duplicate_jaccard_threshold` | 0.80 | near-duplicate 확정 Jaccard 임계값 |

### PreprocessingConfig (전처리)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `min_sentence_length` | 5 | 최소 문장 길이 |
| `max_sentence_length` | 500 | 최대 문장 길이 |
| `filing_subtypes` | rule dict | 공시 subtype 분류 |
| `news_subtypes` | rule dict | 뉴스 subtype 분류 |

### NERConfig (엔티티 추출)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `min_entity_length` | 2 | 최소 엔티티 문자 수 |
| `max_entity_length` | 30 | 최대 엔티티 문자 수 |
| `ner_confidence_threshold` | 0.5 | recall 우선 낮은 임계값 |
| `trigger_lexicon` | 14개 타입 사전 | 이벤트 트리거 표현 사전 |

### EntityTypingConfig (타입 분류)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `exact_match_confidence` | 0.80 | 사전 정확 매칭 confidence |
| `fuzzy_match_threshold` | 80 | rapidfuzz score 임계값 |
| `llm_fallback_threshold` | 0.60 | LLM fallback 분기점 |

### EntityResolutionConfig (Entity Resolution)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `embedding_similarity_threshold` | 0.80 | embedding 유사도 임계값 |
| `alias_fuzzy_threshold` | 80 | alias fuzzy match 임계값 |
| `placeholder_confidence` | 0.50 | placeholder 생성 분기점 |

### EventExtractionConfig (이벤트 추출)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `event_confidence_threshold` | 0.50 | 이벤트 후보 생성 최소 confidence |
| `fact_keywords` | keyword list | 확정 사실 판정 키워드 |
| `interpretation_keywords` | keyword list | 해석/예측 판정 키워드 |

### EventCanonicalizationConfig (Event Canonicalization)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `same_event_threshold` | 0.85 | 확정 병합 임계값 |
| `maybe_same_threshold` | 0.65 | 낮은 confidence 병합 임계값 |
| `time_window_days` | 7 | 블로킹 시간 윈도우 |
| `field_weights` | 6개 필드 | 유사도 계산 가중치 |

### Neo4jConfig (그래프 적재)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `uri` | `bolt://localhost:7687` | Neo4j 연결 URI |
| `precedes_max_lag_days` | 30 | PRECEDES 엣지 생성 시간 윈도우 |
| `batch_size` | 500 | 배치 적재 크기 |

### LLMConfig (LLM)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `model_name` | `Qwen/Qwen2.5-3B-Instruct` | 사용 모델 |
| `device` | `cuda` | GPU 디바이스 |
| `torch_dtype` | `float16` | T4 GPU 최적화 FP16 |
| `max_new_tokens` | 1024 | 최대 생성 토큰 수 |
| `load_in_4bit` | False | 4bit 양자화 옵션 |

### AgentConfig (에이전트)

| 파라미터 | 기본값 | 역할 |
|----------|--------|------|
| `max_hops` | 2 | 기본 탐색 hop 수 |
| `max_subgraph_nodes` | 50 | subgraph 최대 노드 수 |
| `min_edge_confidence` | 0.60 | 탐색 엣지 최소 confidence |
| `temporal_window_days` | 90 | 기본 시간 윈도우 |
| `prohibited_phrases` | 7개 | Risk Controller 금지 문구 |

---

## 4. 하네스 엔지니어링 확장 관리 항목

현재 코드의 `PipelineConfig`는 실행 파라미터를 관리한다. 하네스 엔지니어링을 적용하면 여기에 대응되는 **운영 레벨 설정 묶음**을 별도로 관리하는 것이 좋다.

### 4.1 Constraint Layer 설정

권장 관리 항목:

| 항목 | 설명 |
|------|------|
| tool boundary policy | 어떤 컴포넌트가 어떤 tool/API를 호출할 수 있는가 |
| dependency rule | planner가 retrieval을 우회하지 못하도록 하는 규칙 |
| safety rule | 투자 권유, 과도한 확신, 무근거 인과 단정 금지 |
| retry budget | self-repair 최대 재시도 횟수 |

권장 파일 또는 저장 위치 예:

- `constraint_policy.yaml`
- CI 환경 변수 또는 release profile

### 4.2 Context Layer 설정

권장 관리 항목:

| 항목 | 설명 |
|------|------|
| ontology version | 이벤트 타입, entity 타입, edge 제약 버전 |
| schema version | trace / eval / answer schema 버전 |
| prompt bundle version | planner / composer / checker 프롬프트 버전 |
| eval slice version | 질의 슬라이스 구성 버전 |
| failure taxonomy version | 오류 분류 기준 버전 |

이 자산은 agent가 항상 참고해야 하는 "실행 가능한 문맥"이므로 문서 설명만으로 두지 말고 구조화 파일로 관리하는 것이 좋다.

### 4.3 Verification Layer 설정

권장 관리 항목:

| 항목 | 설명 |
|------|------|
| evidence sufficiency threshold | 핵심 주장당 최소 근거 수 |
| temporal consistency threshold | 시점 정합성 허용 범위 |
| unsupported claim fail condition | 근거 없는 주장 허용 한계 |
| advice risk threshold | 위험 문구 차단 임계값 |
| regression gate profile | 어떤 metric 하락을 hard fail로 볼지 |

### 4.4 Feedback Loop Layer 설정

권장 관리 항목:

| 항목 | 설명 |
|------|------|
| drift alert threshold | alias/event drift 감지 임계값 |
| cleanup TTL | trace / experiment 산출물 보관 기간 |
| rollback rule | 회귀 시 어떤 버전으로 되돌릴지 |
| review escalation rule | human-in-the-loop 발동 조건 |

---

## 5. CI/CD Gate 관점의 설정 관리

하네스 엔지니어링에서는 "설정 변경" 자체가 실험 단위가 된다. 따라서 아래 메타데이터를 같이 남기는 것이 중요하다.

| 메타데이터 | 설명 |
|------------|------|
| `run_id` | 평가/실험 실행 식별자 |
| `dataset_version` | 사용한 평가셋 버전 |
| `prompt_bundle_version` | 프롬프트 묶음 버전 |
| `retriever_version` | retrieval 정책 버전 |
| `extractor_version` | extraction 정책 버전 |
| `config_snapshot` | 실제 사용된 threshold와 설정 스냅샷 |
| `aggregate_metrics` | top-level metric 요약 |
| `slice_metrics` | 질의 슬라이스별 성능 |

권장 게이트 정책 예시는 다음과 같다.

- hard gate:
  - ontology violation 발생
  - safety/compliance fail
  - schema validation fail
- soft gate:
  - grounded answer score 하락
  - temporal consistency 하락
  - latency / cost 급증

---

## 6. 설계 의사결정 근거

**왜 dataclass 기반인가?**
Pydantic과 달리 런타임 검증 비용이 없고, `field(default_factory=...)`로 mutable default를 안전하게 선언할 수 있다. 설정 파라미터는 파이프라인 초기화 시 1회 로드되므로 런타임 검증보다 정적 명확성이 중요하다.

**왜 모든 Config를 하나의 파일에 모으는가?**
단계별로 Config 파일을 분리하면 관련 파라미터가 산재되어 조정 시 여러 파일을 열어야 한다. `settings.py` 하나에 모으면 "이 파라미터가 어느 단계에 속하는가"를 즉시 파악하고, 단계 간 파라미터 의존 관계도 한눈에 볼 수 있다.

**왜 하네스 설정을 별도로 문서화하는가?**
실행 파라미터만 관리하면 "코드는 왜 바뀌었는가"는 보여도 "운영 규칙과 평가 기준이 왜 바뀌었는가"는 남지 않는다. 금융 AI 에이전트는 안전성·최신성·근거성을 함께 관리해야 하므로, 실행 설정과 운영 설정을 같이 버전 관리해야 한다.
