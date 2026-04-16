# 01. 오프라인 파이프라인 (Offline Pipeline)

## 1. 목적

상시 실행되는 백그라운드 파이프라인으로, 외부 소스에서 문서를 수집하고 KG를 지속적으로 갱신한다. 온라인 파이프라인(에이전트)이 탐색할 KG의 기반을 구축한다.

하네스 엔지니어링 관점에서 오프라인 파이프라인의 목적은 두 가지다.

- **데이터 substrate를 안정적으로 구축**한다.
- **어느 단계에서 품질이 깨졌는지 분해 가능한 상태**를 만든다.

즉, 오프라인 파이프라인은 단순 ETL이 아니라 이후 에이전트 품질을 지탱하는 **검증 가능한 생산 라인**이다.

---

## 2. Harness-aware 실행 흐름

`main.py`의 `run_full_pipeline()` 함수가 전체 오프라인 파이프라인을 순차 실행한다. 하네스 관점의 전체 흐름은 아래와 같다.

```text
[초기화]
FinancialKGPipeline.__init__()
  - ReferenceDataManager 초기화
  - 수집 / 전처리 / 그래프 모듈 인스턴스 생성
  - LLM 모델 로드

        │
        ▼
[STEP 1] Collection
  DART / Naver 수집
  -> 정규화
  -> 문서 중복 제거 / canonicalization
        │
        ├─ Verify:
        │   coverage, freshness, parsing_success, duplicate_rate
        │
        ▼
[STEP 2] Preprocessing
  문장 분리
  -> NER
  -> Entity Typing
  -> Entity Resolution
  -> Event Extraction
  -> Event Canonicalization
        │
        ├─ Verify:
        │   ner/entity/event quality, event time consistency
        │
        ▼
[STEP 3] Graph Build
  GraphPayload 생성
  -> InMemoryGraphStore 적재
        │
        ├─ Verify:
        │   schema validity, ontology constraint, orphan ratio,
        │   event-to-evidence linkage
        │
        ▼
[STEP 4] Agent Init
  entity_dict 구성
  -> AgentOrchestrator 초기화
        │
        ▼
[Offline Registry]
  trace 저장
  metric 요약
  regression gate 판정
```

---

## 3. 현재 구현의 단계별 흐름

### 3.1 초기화

`FinancialKGPipeline.__init__()`에서 수행되는 작업:

```python
asyncio.get_event_loop().run_until_complete(
    self.ref_data.load_from_dart(self.config.collection.dart_api_key)
)

self.llm_client = create_llm_client(self.config.llm, use_mock=use_mock_llm)
self.llm_client.load_model()
```

초기화 단계에서 reference entity와 모델이 준비되어야 이후 단계의 deterministic behavior를 비교하기 쉽다.

### 3.2 STEP 1: 문서 수집

- `CollectionOrchestrator.collect_all()`
- `RawDocumentNormalizer.normalize_batch()`
- `DocumentFingerprinter.process_batch()`

출력:

- `List[CanonicalDocument]`

현재 구현 기준 체크포인트:

- `checkpoints/step1_canonical_docs.json`

### 3.3 STEP 2: 전처리

- `DocumentPreprocessor.preprocess_batch()`
- `NERExtractor.extract_batch()`
- `EntityTypeClassifier.classify_batch()`
- `EntityResolver.resolve_batch()`
- `EventExtractor.extract()`
- `EventCanonicalizer.canonicalize()`

출력:

- `all_resolved_mentions`
- `event_candidates`
- `canonical_events`
- `canonical_docs`

현재 구현에서는 이 단계 산출물을 별도 파일로 항상 저장하지는 않는다. 하네스 확장 시 `step2_output.json` 같은 명시적 중간 산출물 체크포인트를 추가하는 것이 바람직하다.

### 3.4 STEP 3: KG 적재

- `GraphPayloadBuilder.build()`
- `InMemoryGraphStore.load_payload()`

출력:

- `GraphPayload`
- 갱신된 `graph_store`

현재 구현 기준 체크포인트:

- `graph_store.json`

하네스 확장 시 `step3_graph_output.json` 형태의 raw `GraphPayload` 저장도 권장한다.

### 3.5 STEP 4: 에이전트 초기화

- entity dictionary 구성
- `AgentOrchestrator` 준비

이 단계는 품질 개선보다 **실행 준비 상태**를 확인하는 성격이 강하다.

---

## 4. 단계별 성공 조건과 실패 조건

| 단계 | 성공 조건 | 실패 조건 |
|------|-----------|-----------|
| STEP 1 수집 | 핵심 공시/뉴스가 freshness 내 수집되고 파싱 가능 | 수집 누락, API 실패, parsing 실패, duplicate 폭증 |
| STEP 1 canonicalization | 동일/정정 문서가 올바르게 묶임 | 다른 문서 오병합, 업데이트 문서 연결 실패 |
| STEP 2 entity/event | 엔티티, 시간, 숫자, 역할이 구조화됨 | alias 실패, event role 오류, event time 누락 |
| STEP 3 graph build | 노드/엣지가 ontology 제약에 맞게 연결 | orphan node, stale edge, evidence 없는 event 과다 |
| STEP 4 agent init | entity_dict와 graph state가 동기화 | 오래된 KG를 참조, missing entity alias |

---

## 5. Offline Verification Layer

오프라인 계층의 핵심 검증 항목은 아래와 같다.

### 5.1 문서 수집 / canonicalization

- `ingestion_coverage`
- `freshness_lag_minutes`
- `parsing_success_rate`
- `duplicate_rate`
- `dedup_group_purity`
- `canonical_link_accuracy`

핵심 질문:

- 중요한 공시/뉴스가 제때 들어왔는가
- 정정 공시와 업데이트 기사를 parent-child로 잘 연결했는가
- 같은 사건을 과도하게 여러 canonical document로 남기지 않았는가

### 5.2 엔티티 / 이벤트 추출

- `ner_f1`
- `entity_link_acc`
- `alias_resolution_acc`
- `event_detection_f1`
- `event_argument_f1`
- `event_time_acc`

핵심 질문:

- `"현대차"`, `"현대자동차"`, ticker/corp code를 같은 엔티티로 묶는가
- 돈, 비율, 날짜, 대상 기업을 정확히 뽑는가
- event trigger는 맞는데 subject/object가 뒤바뀌는 문제는 없는가

### 5.3 그래프 적재

- `node_edge_schema_validity`
- `ontology_violation_count`
- `orphan_event_ratio`
- `event_to_evidence_link_rate`
- `graph_update_latency`

핵심 질문:

- 그래프에 적재는 되었지만 연결이 끊기지 않았는가
- evidence 없는 event가 과도하지 않은가
- 최신 이벤트가 stale edge 정책 때문에 누락되지 않았는가

---

## 6. Constraint Layer

오프라인 파이프라인에도 제약이 필요하다.

| 제약 | 설명 |
|------|------|
| 수집기는 허용된 API와 허용된 lookback 범위만 사용 | 예기치 않은 데이터 폭증 방지 |
| canonicalization 이전에 KG를 직접 갱신하지 않음 | raw noisy data가 graph에 직접 들어가는 것 방지 |
| GraphPayloadBuilder만 graph schema를 생성 | 모듈별 임의 노드/엣지 생성 금지 |
| schema validation 실패 시 적재 중단 | 잘못된 payload 확산 방지 |

---

## 7. Feedback Loop Layer

오프라인 계층의 실패는 다음 루프로 복구한다.

### 7.1 자동 복구

- API timeout / 일시적 connector 실패: 재시도
- 문서 본문 fetch 실패: 제목 기반 최소 문서로 강등
- parsing 실패 증가: 해당 source를 quarantine bucket으로 분리
- graph validation 실패: payload 저장 후 적재 중단

### 7.2 분석과 개선

실패는 아래 정보와 함께 저장하는 것이 좋다.

- failure stage
- affected document ids
- failure taxonomy code
- config snapshot
- retry 여부
- repair action

이후 개선 루프는 다음 순서로 수행한다.

1. baseline run 수행
2. stage metric 확인
3. failure taxonomy별 top issue 확인
4. 병목 한 개 수정
5. 동일 eval set 재실행
6. 회귀 여부 확인 후 승인 또는 롤백

---

## 8. Drift / Cleanup / Entropy Management

오프라인 시스템은 시간이 지날수록 엔트로피가 쌓인다. 이를 방치하면 retrieval과 reasoning 품질이 서서히 무너진다.

권장 운영 전략:

- 새 alias / 새 이벤트 표현 drift 모니터링
- correction / follow-up 문서 연결 실패율 점검
- 오래된 checkpoint와 trace의 TTL 관리
- obsolete graph snapshot 정리
- ontology change가 있을 때 이전 run과 비교 가능한 migration log 유지

---

## 9. CI/CD Gate와 회귀 테스트

오프라인 파이프라인은 다음 두 종류의 gate를 두는 것이 좋다.

### 9.1 Smoke Gate

짧은 문서로 빠르게 확인한다.

- connector 동작 여부
- schema serialization 여부
- graph payload 생성 여부
- critical exception 유무

### 9.2 Regression Gate

gold eval asset 또는 고정 샘플셋으로 품질을 비교한다.

- `entity_link_acc` 급락
- `event_time_acc` 급락
- `ontology_violation_count` 증가
- `event_to_evidence_link_rate` 하락

hard gate 예:

- schema validation fail
- ontology violation 발생
- orphan ratio 급증

soft gate 예:

- freshness 악화
- event extraction 품질 소폭 하락
- latency 증가

---

## 10. 설계 의사결정 근거

**왜 각 STEP을 별도 메서드로 분리하는가?**
단계별 독립 실행을 지원하기 위해서다. STEP 2 로직을 수정했을 때 STEP 1(수집)을 재실행할 필요가 없다. 체크포인트 기반의 단계적 재실행은 개발·디버깅 사이클을 크게 단축한다.

**왜 오프라인 단계에서도 하네스가 필요한가?**
온라인 답변 품질의 상당 부분은 retrieval 이전의 데이터 substrate 품질에 의해 결정된다. offline metric이 나쁘면 reasoning을 아무리 고도화해도 의미가 없다.

**왜 중간 산출물 체크포인트가 중요한가?**
failure localization과 regression 비교를 위해서다. STEP 2/3 산출물이 남아 있어야 "추출기가 틀렸는지"와 "그래프 적재가 틀렸는지"를 분리할 수 있다.
