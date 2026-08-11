# 문서 구조 (Document Tree)

## 설계서 → 문서 대응 구조

이 문서는 아래 구조를 따른다.

- 도메인/문제 정의와 전체 아키텍처
- 오프라인 데이터 파이프라인
- 전처리와 엔티티/이벤트 추출
- 온톨로지와 그래프 적재
- Agentic GraphRAG
- 설정 / 스키마 / 런타임
- 하네스 엔지니어링 관점의 운영 규칙

즉, 문서는 "무엇을 구현했는가"와 "어떻게 운영하고 검증할 것인가"를 함께 다룬다.

---

## 전체 문서 트리

```text
docs/
├── INDEX.md                                    ← 이 파일
├── 00_overview.md                              ← 배경/목표/문제정의/하네스 레이어/이중 파이프라인
│
├── 01_data_pipeline/                           ← 문서 수집
│   ├── 01_ingestion.md                         ← DART/Naver 비동기 수집, 정정 공시 처리
│   └── 02_normalization.md                     ← 정규화, 중복 판별, 체크포인트
│
├── 02_preprocessing/                           ← 문서 전처리
│   ├── 01_doc_preprocessor.md                  ← 문장 분리, 서브타입 분류
│   ├── 02_ner_extractor.md                     ← 사전/Rule/Trigger recall 우선 추출
│   ├── 03_entity_type_classifier.md            ← Reference→Fuzzy→Rule→LLM 타입 확정
│   ├── 04_entity_resolver.md                   ← canonical_entity_id 해소, placeholder
│   ├── 05_event_extractor.md                   ← Event Frame, factuality/certainty 판정
│   └── 06_event_canonicalizer.md               ← 이벤트 단위 중복 병합
│
├── 03_knowledge_graph/                         ← 온톨로지 / 그래프 적재
│   ├── 01_ontology.md                          ← 정적/동적/증거 3개 계층, 엔티티/엣지
│   ├── 02_graph_schema.md                      ← 노드/엣지 스키마, 적재/스킵 조건
│   └── 03_graph_loader.md                      ← GraphPayloadBuilder, PassageIndex 구축
│
├── 04_agent_system/                            ← Agentic GraphRAG (검증 가능한 멀티 에이전트 오케스트레이션)
│   ├── 01_agent_architecture.md                ← 전체 컴포넌트, 실행 루프, contract, trace/ledger
│   ├── 02_query_understanding_and_routing.md   ← QuerySpec, NeedLevel, Retrieval Policy Builder
│   ├── 03_retrieval_workers.md                 ← Graph/Hybrid/Document-block worker, EvidenceBlock
│   ├── 04_evidence_and_claims.md               ← Evidence Requirement Gate, Context Builder, Claim-first Generator
│   ├── 05_verification_and_answer_gate.md      ← 결정적 Claim Verifier, Answer Gate
│   └── 06_recovery_memory_and_harness.md       ← Critic/Supervisor 복구, 사용자 메모리, 위험 관리
│
├── 05_config_and_schemas/
│   ├── 01_pipeline_config.md                   ← 전체 Config와 하네스 확장 관리 항목
│   └── 02_data_schemas.md                      ← 코어 스키마 + trace/eval/run/ledger schema
│
└── 06_pipeline_runtime/
    ├── 01_offline_pipeline.md                  ← offline flow, verification, regression gate
    └── 02_online_query_pipeline.md             ← online flow, self-repair, HITL, metrics
```

---

## 빠른 참조

| 찾고 싶은 것 | 문서 |
|-------------|------|
| **전체 파이프라인** | [00_overview.md](00_overview.md) |
| **문제 정의 / 입력 / 출력 / 실패 리스크** | [00_overview.md § 3](00_overview.md) |
| **Constraint / Context / Verification / Feedback Loop** | [00_overview.md § 6](00_overview.md) |
| **질문 유형과 금융 특화 failure taxonomy** | [00_overview.md § 4](00_overview.md), [00_overview.md § 9](00_overview.md) |
| DART/Naver 수집 방식 | [01_data_pipeline/01_ingestion.md](01_data_pipeline/01_ingestion.md) |
| SimHash/Jaccard 중복 판별 | [01_data_pipeline/02_normalization.md](01_data_pipeline/02_normalization.md) |
| NER 4전략 (recall 우선) | [02_preprocessing/02_ner_extractor.md](02_preprocessing/02_ner_extractor.md) |
| Entity Resolution 상세 | [02_preprocessing/04_entity_resolver.md](02_preprocessing/04_entity_resolver.md) |
| 이벤트 타입 계층 | [03_knowledge_graph/01_ontology.md](03_knowledge_graph/01_ontology.md) |
| 노드/엣지 스키마 + 적재 조건 | [03_knowledge_graph/02_graph_schema.md](03_knowledge_graph/02_graph_schema.md) |
| PassageIndex 구조 | [03_knowledge_graph/03_graph_loader.md](03_knowledge_graph/03_graph_loader.md) |
| 에이전트 전체 구조, 실행 루프, ledger | [04_agent_system/01_agent_architecture.md](04_agent_system/01_agent_architecture.md) |
| QuerySpec 생성 프롬프트와 Retrieval Policy | [04_agent_system/02_query_understanding_and_routing.md](04_agent_system/02_query_understanding_and_routing.md) |
| Graph/Hybrid/Document-block retrieval, EvidenceBlock 구조 | [04_agent_system/03_retrieval_workers.md](04_agent_system/03_retrieval_workers.md) |
| Evidence Requirement Gate, Claim-first 생성 | [04_agent_system/04_evidence_and_claims.md](04_agent_system/04_evidence_and_claims.md) |
| 결정적 수치·시간·귀속 검증, Answer Gate | [04_agent_system/05_verification_and_answer_gate.md](04_agent_system/05_verification_and_answer_gate.md) |
| Critic/Supervisor 복구, 사용자 메모리, 위험 관리 | [04_agent_system/06_recovery_memory_and_harness.md](04_agent_system/06_recovery_memory_and_harness.md) |
| KG Miss와 self-repair, 실시간 보완 수집 | [06_pipeline_runtime/02_online_query_pipeline.md](06_pipeline_runtime/02_online_query_pipeline.md) |
| 오프라인 검증 포인트와 regression gate | [06_pipeline_runtime/01_offline_pipeline.md](06_pipeline_runtime/01_offline_pipeline.md) |
| 설정과 CI/CD gate 관점의 버전 관리 | [05_config_and_schemas/01_pipeline_config.md](05_config_and_schemas/01_pipeline_config.md) |
| trace / eval / run / ledger metadata schema | [05_config_and_schemas/02_data_schemas.md](05_config_and_schemas/02_data_schemas.md) |
