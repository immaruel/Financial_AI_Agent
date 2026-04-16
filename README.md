# 금융 AI 에이전트

---

## 1. 프로젝트 배경 및 동기

최근 파운데이션 모델의 범용 성능은 빠르게 향상되었지만, **금융과 같이 정확성·관계 이해·최신성이 중요한 도메인**에서는 모델 자체의 성능만으로 고품질 응답을 안정적으로 보장하기 어렵다.

특히 단순 텍스트 검색 기반의 RAG 구조는 다음 한계를 가진다.

- **객체 간 관계 표현 불가**: 기업-계열사-공급망-규제 등의 다단계 연결을 텍스트 청크로 전달하면 LLM이 관계를 추론에 과도하게 의존해야 한다.
- **컨텍스트 오염**: 관련 문서와 무관한 정보가 함께 입력되어 응답 품질이 불안정해진다.
- **멀티홉 추론 한계**: "이 정책이 어떤 산업을 거쳐 어떤 기업에 영향을 미치는가" 같은 다단계 질의에 적합한 구조가 아니다.
- **운영 난이도 증가**: 파이프라인이 복잡해질수록 "어디서 틀렸는가"를 분해하지 못하면 개선 속도가 급격히 느려진다.

이 문제를 해결하기 위해 **텍스트 정보를 단순 문서가 아닌 구조화된 지식으로 관리**하고, 동시에 **AI Agent가 인간 개입 없이도 안정적으로 동작하도록 하네스 엔지니어링(Harness Engineering) 계층**을 함께 설계한다.

```
1. 금융 도메인의 핵심 객체와 관계를 온톨로지로 정의한다.
2. 공시·뉴스로부터 엔티티와 이벤트를 추출해 지식 그래프(KG)를 구축한다.
3. 사용자 질의가 입력되면 관련 Sub-graph를 Retrieval한다.
4. 추출된 Sub-graph를 LLM의 Input Context로 구성한다.
5. 각 단계는 Constraint / Context / Verification / Feedback Loop 하네스에 의해 감시된다.
```

이 방식은 객체 간 관계 파악, 멀티홉 추론, 조건 기반 질의에서 일반 RAG 대비 높은 정확성과 응답 일관성을 기대할 수 있다. 금융 도메인은 기업·상품·거래·이벤트 같은 명확한 엔티티와 관계가 존재하므로, 지식 그래프 기반 Retrieval의 효과를 검증하기에 적합한 영역이다.

---

## 2. 시스템 목표 (Goal)

이 프로젝트의 목표는 두 층으로 정의한다.

### 2.1 제품 목표

> **산업·테마·기업 정보·뉴스·공시 같은 금융 이벤트를 온톨로지 기반 지식 그래프로 구조화하고, 이를 활용하는 Agentic GraphRAG 파이프라인을 설계·구현한다.**

### 2.2 하네스 목표

> **AI Agent가 인간 개입 없이도 대부분의 금융 질의를 안정적으로 처리하되, 고위험·저신뢰·시스템 실패 상황에서만 제한적으로 인간 개입을 요청하도록 운영 하네스를 설계한다.**

즉, 이 문서는 "무엇을 만들 것인가"뿐 아니라 "어떻게 검증하고, 실패를 추적하고, 회귀를 막을 것인가"까지 포함한다.

---

## 3. 문제 정의 (Problem Definition)

| 항목 | 내용 |
|------|------|
| 해결하려는 문제 | 금융 공시/뉴스/관계 정보를 구조화하여 신뢰 가능한 질의응답을 제공 |
| 입력 데이터 유형 | DART 공시, 뉴스 기사, reference entity data, 사용자 자연어 질의 |
| 출력 요구사항 | 근거 기반 답변, 타임라인, 관련 기업, citation, risk warning, confidence |
| 실패 시 리스크 | 기업 혼동, 시간 불일치, 숫자/단위 오류, 과장된 인과, 근거 없는 전망, 투자 권유성 문장 |

금융 도메인에서는 단순 정답률보다 아래 항목이 중요하다.

- 답변이 실제 evidence와 일치하는가
- 시간축이 맞는가
- 동일 기업 alias를 올바르게 resolve했는가(ex. 현대자동차, 현대차)
- 사건 인과 관계를 과장하지 않았는가
- 투자 권유성 표현을 적절히 제어했는가

이 때문에 본 시스템은 **오프라인 KG 구축 품질**과 **온라인 Agentic GraphRAG 품질**을 분리 평가해야 하며, 최종적으로는 **failure localization이 가능한 구조**를 갖춰야 한다.

---

## 4. 처리해야 하는 질의 유형

이 시스템이 처리해야 하는 금융 질의는 4가지 유형으로 정의한다.

### 4.1 사실 조회 (Fact Lookup)

특정 기업 또는 산업에 일어난 사실 기반 질의.

- "현대차에 최근 어떤 이벤트가 있었는가?"
- "어떤 뉴스/공시가 어떤 산업·테마와 연결되는가?"

### 4.2 관계 추론 (Relationship Reasoning)

엔티티 간 구조적 관계를 다단계로 탐색하는 질의.

- "이 이벤트가 어떤 기업군에 전이될 가능성이 있는가?"
- "공급망·경쟁구도·정책 수혜/피해 관계가 무엇인가?"

### 4.3 시간축 추적 (Temporal Tracking)

이벤트의 시간 연쇄와 패턴을 추적하는 질의.

- "어떤 이벤트가 먼저 발생했고, 이후 무엇이 연쇄적으로 이어졌는가?"
- "과거 유사 이벤트 패턴은 무엇이었는가?"

### 4.4 의사결정 지원 (Decision Support)

복합적 분석을 요구하는 고수준 질의.

- "지금 시장에서 핵심 촉발 요인은 무엇인가?"
- "어떤 종목군을 우선 모니터링해야 하는가?"

---

## 5. 설계 고려사항

시스템 설계 전반에 아래 10가지 원칙이 관통한다.

| # | 원칙 | 내용 |
|---|------|------|
| 1 | **신뢰도 중심의 정보 구조** | 공시(1등급) > IR(2등급) > 뉴스(3등급) > 분석(4등급) > 루머(5등급) 계층으로 출처 품질을 수치화 |
| 2 | **관계 중심의 데이터 모델링** | 산업·기업·이벤트·규제를 Relation 중심으로 구조화해 데이터 간 맥락을 그래프 엣지로 보존 |
| 3 | **금융 맥락 이해 중심 설계** | 이벤트 인과, 산업 영향, 시간 연쇄를 설명할 수 있는 구조를 우선 |
| 4 | **대규모 데이터를 위한 Rule 체계** | 트리거 사전, 엔티티 분류, 이벤트 계층을 사전에 명확히 정의 |
| 5 | **JSON 기반 단계별 Output 관리** | Pydantic 스키마 기반 직렬화와 체크포인트 저장으로 단계별 독립 재실행 지원 |
| 6 | **비동기 I/O 활용** | 외부 API 호출은 비동기 병렬 처리, CPU 집약 단계는 병렬화 가능 구조로 설계 |
| 7 | **단계별 파라미터 조정** | `PipelineConfig`를 통해 원인 단계 추적과 임계값 조정을 용이하게 함 |
| 8 | **도구 경계 명확화** | 수집, 추출, 그래프 구성, 답변 생성, 위험 제어가 서로의 책임을 침범하지 않도록 분리 |
| 9 | **검증 가능한 컨텍스트 관리** | 문서 설명을 ontology/schema/context bundle 같은 실행 가능한 기준으로 구조화 |
| 10 | **피드백 루프 내장** | 실패를 trace, metric, failure taxonomy로 수집하고 반복 개선 가능한 운영 구조를 포함 |

---

## 6. 하네스 시스템 아키텍처

하네스는 4개 레이어로 정의한다.

| 레이어 | 목적 | 금융 AI 에이전트에서의 역할 |
|--------|------|-----------------------------|
| Constraint Layer | 에이전트의 행동 경계 정의 | 투자 권유 금지, 무근거 인과 단정 금지, 허용된 tool 사용 범위 제한 |
| Context Layer | 항상 참고해야 하는 기준 정보 구조화 | ontology, schema, prompt bundle, eval slice, failure taxonomy, context files |
| Verification Layer | 출력 검증과 자동 평가 | schema validation, evidence sufficiency, temporal consistency, unsupported claim 탐지 |
| Feedback Loop Layer | 실패 후 원인 분석과 self-repair | trace 기반 병목 분석, 재시도, 회귀 감지, 규칙/프롬프트/파라미터 업데이트 |

이 4개 레이어는 오프라인/온라인 파이프라인 모두에 공통으로 적용된다.

---

## 7. 이중 파이프라인 구조

시스템은 **오프라인 파이프라인**과 **온라인 파이프라인** 두 계층으로 분리되며, 각 계층 옆에 검증·회귀·피드백 하네스가 붙는다.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                    OFFLINE PIPELINE (상시 실행)                       │
│                                                                      │
│  [STEP 1] 문서 수집                                                   │
│   DART / Naver API-> RawDocument -> CanonicalDocument                │
│                                                                      │
│  [STEP 2] 문서 전처리                                                  │
│   문장분리 -> NER -> 타입분류 -> Entity Resolution                      │
│   -> 이벤트 추출 -> Event Canonicalization                             │
│                                                                      │
│  [STEP 3] KG 지식 그래프 적재                                          │
│   GraphPayloadBuilder -> InMemoryGraphStore -> PassageIndex          │
│                                                                      │
│  [Offline Verification]                                              │
│   coverage / dedup / entity / event / graph validity                 │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    ONLINE PIPELINE (질의 시 실행)                     │
│                                                                      │
│  사용자 질의                                                           │
│   -> Query Planner                                                   │
│   -> Graph Retriever                                                 │
│   -> Evidence Retriever                                              │
│   -> Causal Reasoner                                                 │
│   -> Hypothesis Checker                                              │
│   -> Answer Composer                                                 │
│   -> Risk Controller                                                 │
│                                                                      │
│  [Online Verification]                                               │
│   evidence sufficiency / temporal consistency / safety / faithfulness│
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        HARNESS SIDE-CAR LAYERS                       │
│                                                                      │
│  Constraint  |  Context  |  Verification  |  Feedback Loop           │
│  CI/CD Gate  |  Trace    |  Metrics       |  Experiment Registry     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. End-to-End 데이터 흐름

```text
외부 API (DART / Naver)
      │
      ▼
RawDocument                    ← collection/source_connector.py
      │  정규화 + 중복 판별
      ▼
CanonicalDocument              ← collection/raw_normalizer.py
                               ← collection/document_fingerprint.py
      │  문장 분리 + 서브타입 분류
      ▼
PreprocessedDocument           ← preprocessing/doc_preprocessor.py
      │  사전/Rule/Trigger 기반 추출
      ▼
MentionSpan                    ← preprocessing/ner_extractor.py
      │  타입 확정 및 정규화
      ▼
TypedMention                   ← preprocessing/entity_type_classifier.py
      ▼
ResolvedMention                ← preprocessing/entity_resolver.py
      │  Event Frame 생성
      ▼
EventCandidate                 ← preprocessing/event_extractor.py
      │  중복 병합
      ▼
CanonicalEvent                 ← preprocessing/event_canonicalizer.py
      │  노드/엣지/PassageIndex 변환
      ▼
GraphPayload                   ← ontology/graph_loader.py
      ▼
InMemoryGraphStore             ← ontology/graph_loader.py
      │  7-에이전트 파이프라인 탐색
      ▼
StructuredAnswer               ← agent/agents.py
```

하네스 관점에서는 위 흐름의 각 단계마다 아래 trace를 남기는 것이 중요하다.

- 입력/출력 스키마 버전
- confidence / score
- 사용된 문서·노드·evidence 식별자
- 실패 원인과 recovery action
- latency / cost / retry 횟수

---

## 9. 실패 분류와 인간 개입 기준

### 9.1 금융 특화 Failure Taxonomy

| 코드 | 오류 유형 | 예시 |
|------|----------|------|
| F1 | 엔티티 혼동 | 다른 회사와 혼동, ticker mismatch, 계열사/본사 혼동 |
| F2 | 시간축 오류 | 최신 정보 대신 과거 정보 사용, 발표일과 효력일 혼동 |
| F3 | 숫자 오류 | 금액/비율/단위 오류, 절대값과 증감률 혼동 |
| F4 | 이벤트 귀속 오류 | 주체 기업과 대상 기업 뒤바뀜 |
| F5 | 근거 누락 | 핵심 citation 부족, 반대 evidence 누락 |
| F6 | 추론 과장 | 상관관계를 인과로 단정, 가능성을 사실처럼 표현 |
| F7 | 안전성 오류 | 투자 권유, 과도한 확신, 리스크 경고 누락 |
| F8 | 과잉 방어 | 답할 수 있는 질문도 불필요하게 회피 |

### 9.2 Human-in-the-loop 개입 조건

인간 개입은 다음 상황에서만 허용한다.

- high-risk decision
- low-confidence output
- system failure

구체적으로는 아래 조건 중 하나를 만족할 때 human review 대상으로 분류한다.

- entity ambiguity가 임계값 이상
- 핵심 주장에 대응하는 evidence가 부족
- temporal consistency 검증 실패
- risk controller가 고위험 투자 표현을 감지
- self-repair 재시도 횟수 초과

---

## 10. 엔트로피 관리와 평가 프레임워크

### 10.1 Entropy Management

시스템이 시간이 지나면서 망가지지 않도록 아래 운영 규칙을 둔다.

- **데이터 drift 관리**: 새 alias, 새 이벤트 표현, 새 정책 키워드를 주기적으로 수집
- **규칙 업데이트 방식**: 룰 변경 시 prompt/version/config snapshot을 함께 기록
- **자동 cleanup 전략**: 오래된 trace 압축, 실험 산출물 TTL 관리, stale cache 제거
- **정정/후속 문서 우선 반영**: correction filing, updated article, follow-up report를 최신 기준으로 연결

### 10.2 Evaluation Framework

하네스는 아래 6개 축을 기본 평가 지표로 사용한다.

- Accuracy
- Faithfulness
- Consistency
- Latency
- Cost
- Safety / Compliance

세부 메트릭은 오프라인/온라인 문서에서 단계별로 분리 정의한다.

---

## 11. 관련 문서

| 주제 | 문서 |
|------|------|
| 에이전트 전체 구조와 실행 루프 | [04_agent_system/01_agent_architecture.md](KO/04_agent_system/01_agent_architecture.md) |
| 전체 파라미터 명세와 하네스 확장 관리 항목 | [05_config_and_schemas/01_pipeline_config.md](KO/05_config_and_schemas/01_pipeline_config.md) |
| 데이터 스키마와 trace / eval schema | [05_config_and_schemas/02_data_schemas.md](KO/05_config_and_schemas/02_data_schemas.md) |
| 오프라인 실행 흐름과 검증 포인트 | [06_pipeline_runtime/01_offline_pipeline.md](KO/06_pipeline_runtime/01_offline_pipeline.md) |
| 온라인 질의 처리와 self-repair / HITL | [06_pipeline_runtime/02_online_query_pipeline.md](KO/06_pipeline_runtime/02_online_query_pipeline.md) |
| Query Planner 상세 | [04_agent_system/02_query_planner.md](KO/04_agent_system/02_query_planner.md) |
| Graph Retriever 상세 | [04_agent_system/03_graph_retriever.md](KO/04_agent_system/03_graph_retriever.md) |
| Evidence Retriever 상세 | [04_agent_system/04_evidence_retriever.md](KO/04_agent_system/04_evidence_retriever.md) |
| Causal Reasoner 상세 | [04_agent_system/05_causal_reasoner.md](KO/04_agent_system/05_causal_reasoner.md) |
| Risk Controller / Answer Composer 상세 | [04_agent_system/06_risk_controller_and_answer_composer.md](KO/04_agent_system/06_risk_controller_and_answer_composer.md) |
