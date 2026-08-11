# 02. 데이터 스키마 (Data Schemas)

## 1. 목적

파이프라인 각 단계의 입출력 데이터 구조를 `utils/schemas.py`에서 Pydantic v2 모델로 정의한다. 모든 단계 간 데이터는 이 스키마를 따라 직렬화·역직렬화되며, JSON 체크포인트 저장도 이 구조를 기반으로 한다.

하네스 엔지니어링 관점에서는 여기에 더해 다음 스키마가 필요하다.

- 실행 중간 산출물을 기록하는 trace schema
- 평가용 gold asset schema
- failure taxonomy와 failure case schema
- run metadata / experiment registry schema

즉, 본 문서는 **현재 구현의 코어 데이터 스키마**와 **하네스 확장 시 함께 관리할 운영 스키마**를 함께 설명한다.

---

## 2. 스키마 계층도

```text
[STEP 1: 수집]
RawDocument
  └→ CanonicalDocument

[STEP 2: 전처리]
CanonicalDocument
  └→ PreprocessedDocument (Sentence 목록 포함)
       └→ MentionSpan
            └→ TypedMention
                 └→ ResolvedMention
                      └→ EventCandidate (EvidenceSpan, MoneyAmount 포함)
                           └→ CanonicalEvent

[STEP 3: KG 적재]
ResolvedMention + CanonicalEvent + CanonicalDocument
  └→ GraphPayload (GraphNode + GraphEdge + PassageIndex)

[STEP 4: 에이전트]
QueryPlan
  └→ SubGraphResult
       └→ EvidenceResult
            └→ CausalChain
                 └→ StructuredAnswer

[HARNESS EXTENSION]
EvalSample
  └→ QueryTrace
       └→ RetrievalTrace
            └→ ReasoningTrace
                 └→ AnswerTrace
                      └→ FailureCase / RunRecord

[TARGET ONLINE ORCHESTRATION]
QuerySpecDraft → QuerySpec + RetrievalPolicy + MemorySelection
  └→ WorkerResult / ToolCallTrace
       └→ EvidenceBlock
            └→ Claim
                 └→ VerifierVerdict / RecoveryDecision
```

---

## 3. 코어 스키마 상세

### RawDocument

수집 시점의 원문 1건.

```python
class RawDocument(BaseModel):
    raw_doc_id: str               # prefix: raw_
    source_type: SourceType       # filing / news
    source_url: str
    external_doc_id: str
    original_title: str
    raw_text: str
    original_timestamp: Optional[datetime]
    crawled_at: datetime
    first_seen_at: datetime
    rcept_no: Optional[str]
    corp_code: Optional[str]
    is_correction: bool = False
    parent_rcept_no: Optional[str]
```

### CanonicalDocument

중복/버전 정리 완료된 대표 문서.

```python
class CanonicalDocument(BaseModel):
    canonical_doc_id: str         # prefix: canon_
    source_type: SourceType
    trust_tier: int               # 1~5
    title: str
    normalized_text: str
    published_at: Optional[datetime]
    doc_status: DocStatus         # active / superseded / duplicate
    parent_doc_id: Optional[str]
    dedup_group_id: Optional[str]
    document_class: str
```

### PreprocessedDocument / Sentence

```python
class PreprocessedDocument(BaseModel):
    canonical_doc_id: str
    source_type: SourceType
    title_text: str
    sentences: List[Sentence]
    doc_subtype: str
    published_at: Optional[datetime]

class Sentence(BaseModel):
    sentence_id: str
    text: str
    char_start: int
    char_end: int
```

### ResolvedMention

Entity Resolution 완료 mention.

```python
class ResolvedMention(BaseModel):
    mention_id: str
    mention_text: str
    sentence_id: str
    entity_type: str
    canonical_entity_id: str
    canonical_name: str
    resolution_method: str
    resolution_confidence: float
    resolution_status: ResolutionStatus
```

### EventCandidate

이벤트 프레임 (Canonicalization 전).

```python
class EventCandidate(BaseModel):
    event_candidate_id: str       # prefix: evt_cand_
    canonical_doc_id: str
    source_type: SourceType
    event_type: str
    subject_entity_id: str
    object_entity_id: str
    trigger_text: str
    amount: Optional[MoneyAmount]
    event_time: Optional[datetime]
    certainty: Certainty
    factuality: Factuality
    polarity: Polarity
    evidence: List[EvidenceSpan]
    confidence: float
    slots: Dict[str, Any]
```

### CanonicalEvent

Event Canonicalization 결과. KG의 Event 노드 소스.

```python
class CanonicalEvent(BaseModel):
    canonical_event_id: str       # prefix: canon_evt_
    event_type: str
    subject_entity_id: str
    object_entity_id: str
    amount: Optional[float]
    event_time: Optional[datetime]
    polarity: Polarity
    certainty: Certainty
    source_event_candidate_ids: List[str]
    source_canonical_doc_ids: List[str]
    representative_source_type: str
    confidence: float
    evidence: List[EvidenceSpan]
```

### GraphPayload

KG 적재 단위.

```python
class GraphPayload(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    passage_index: Optional[PassageIndex]
    seed_nodes: List[str]

class GraphNode(BaseModel):
    node_id: str
    label: str
    properties: Dict[str, Any]

class GraphEdge(BaseModel):
    source_id: str
    target_id: str
    edge_type: str
    properties: Dict[str, Any]
```

### StructuredAnswer

에이전트 최종 출력.

```python
class StructuredAnswer(BaseModel):
    summary: str
    timeline: List[Dict[str, Any]]
    related_companies: List[str]
    impact_analysis: str
    counter_evidence: str
    confidence: float
    sources: List[Dict[str, str]]
    risk_warnings: List[str]
```

### 온라인 오케스트레이션 스키마

아래 모델은 `utils/schemas.py`에 구현되어 [에이전트 전체 구조](../04_agent_system/01_agent_architecture.md)의 역할 간 계약으로 쓰인다. 자유 텍스트 상태를 다음 agent에 넘기지 않고, schema 검증 가능한 상태와 실패 원인을 전달하는 데 목적이 있다.

```python
class NeedLevel(str, Enum):
    REQUIRED = "required"
    PREFERRED = "preferred"
    NOT_NEEDED = "not_needed"

class EvidenceNeeds(BaseModel):
    graph_relation: NeedLevel
    primary_source_quote: NeedLevel
    numeric_value: NeedLevel
    table_or_figure: NeedLevel

class QuerySpecDraft(BaseModel):
    query_id: str
    original_query: str
    request_timestamp: datetime
    as_of: datetime
    intent: str
    sub_intents: List[str] = []
    entities: List[Dict[str, str]]
    time: Dict[str, Any]
    answer_format: str
    evidence_needs: EvidenceNeeds
    memory_mode: Literal["off", "if_relevant"] = "if_relevant"
    confidence: float

class QuerySpec(QuerySpecDraft):
    # Entity/Time Validator가 채우는 최종 실행 스펙
    resolved_entities: List[Dict[str, str]]
    resolved_time: Dict[str, Any]

class RetrievalPolicy(BaseModel):
    policy_id: str
    channels: List[str]               # graph / lexical / vector / document_block
    graph_mode: str                   # off / assist / primary
    source_filters: List[str]
    date_filter: Dict[str, Any]
    fusion: Optional[str]             # rrf / none
    embedding_model: Optional[str]    # BAAI/bge-m3
    reranker: Optional[str]
    evidence_budget: int
    retry_budget: int

class WorkerFailure(BaseModel):
    code: str                         # timeout, entity_ambiguous, retrieval_empty ...
    retryable: bool
    detail: Optional[str] = None

class WorkerResult(BaseModel):
    worker: str
    status: Literal["success", "partial", "failed", "skipped"]
    attempt: int
    input_hash: str
    output_ids: List[str] = []
    latency_ms: int
    failure: Optional[WorkerFailure] = None

class EvidenceBlock(BaseModel):
    evidence_id: str
    document_id: str
    source_type: str
    source_url: str
    published_at: Optional[datetime]
    effective_period: Optional[str]
    block_type: str                   # paragraph / table / table_cell / figure / caption
    text: str
    locator: Dict[str, Any]
    content_hash: str

class Claim(BaseModel):
    claim_id: str
    text: str
    claim_type: str                   # numeric / factual / causal / quote
    importance: Literal["critical", "normal"]
    evidence_ids: List[str]

class VerifierVerdict(BaseModel):
    claim_id: str
    coverage: Literal["pass", "fail"]
    entailment: Literal["support", "contradict", "neutral", "unknown"]
    numeric_temporal: Literal["pass", "fail", "not_applicable"]
    attribution: Literal["pass", "fail"]
    reasons: List[str]

class MemorySelection(BaseModel):
    status: Literal["selected", "not_relevant", "blocked"]
    memory_ids: List[str] = []
    reasons: List[str] = []
    excluded: List[Dict[str, str]] = []
    token_budget: int = 0

class ToolCallTrace(BaseModel):
    run_id: str
    worker: str
    tool_name: str
    selected_by: str                  # policy / recovery / deterministic fallback
    arguments_hash: str
    corpus_snapshot: Optional[str]
    status: str
    latency_ms: int
    output_ids: List[str]
```

`NeedLevel`은 필수 검색과 품질 보조 검색을 구분한다. LLM은 QuerySpecDraft를 제안하지만 Validator가 명시적 숫자·표·관계·발언 신호를 보정하고, RetrievalPolicy는 코드가 생성한다. `WorkerResult.status`와 `failure`는 비어 있는 검색 결과를 성공처럼 처리하지 않도록 한다. `ToolCallTrace`에는 원문이나 사용자 메모리 전체를 중복 저장하지 않고, 보안 범위를 지키는 식별자·hash·version을 기록한다.

---

## 4. Harness 확장 스키마

아래 스키마는 현재 코드에 전부 구현되어 있지는 않지만, 하네스 엔지니어링을 적용할 때 별도 파일 또는 registry에 저장할 것을 권장하는 구조다.

### 4.1 EvalSample

평가셋의 기본 단위.

```python
class EvalSample(BaseModel):
    sample_id: str
    query: str
    intent: str
    target_entities: List[str]
    temporal_scope: Dict[str, str]
    expected_event_types: List[str]
    gold_seed_nodes: List[str]
    gold_evidence_ids: List[str]
    gold_answer_points: List[str]
    forbidden_claims: List[str]
    risk_label: str
```

### 4.2 QueryTrace

planner 단계의 관찰 기록.

```python
class QueryTrace(BaseModel):
    run_id: str
    query: str
    normalized_query: str
    planner_output: Dict[str, Any]
    planner_confidence: Optional[float]
    risk_class: Optional[str]
```

### 4.3 RetrievalTrace

retrieval과 evidence 단계의 기록.

```python
class RetrievalTrace(BaseModel):
    run_id: str
    seed_nodes: List[str]
    retrieved_node_ids: List[str]
    retrieved_edge_ids: List[str]
    pruned_node_ids: List[str]
    evidence_ids: List[str]
    contradiction_evidence_ids: List[str]
    retrieval_scores: Dict[str, float]
```

### 4.4 ReasoningTrace / AnswerTrace

```python
class ReasoningTrace(BaseModel):
    run_id: str
    hypotheses: List[str]
    accepted_hypotheses: List[str]
    rejected_hypotheses: List[str]
    checker_verdict: Dict[str, Any]

class AnswerTrace(BaseModel):
    run_id: str
    final_answer: str
    cited_evidence_ids: List[str]
    confidence: float
    risk_flags: List[str]
    latency_ms: int
    token_cost: Optional[float]
```

### 4.5 FailureCase

실패 사례를 taxonomy에 따라 저장하는 구조.

```python
class FailureCase(BaseModel):
    run_id: str
    sample_id: str
    failure_code: str
    failure_stage: str
    root_cause: str
    severity: str
    trace_refs: List[str]
    repair_action: Optional[str]
```

### 4.6 RunRecord

실험/회귀 실행 단위.

```python
class RunRecord(BaseModel):
    run_id: str
    timestamp: datetime
    dataset_version: str
    ontology_version: str
    prompt_bundle_version: str
    config_snapshot: Dict[str, Any]
    aggregate_metrics: Dict[str, float]
    slice_metrics: Dict[str, Dict[str, float]]
    failure_cases: List[str]
```

---

## 5. Failure Taxonomy

권장 failure taxonomy는 아래 8개 범주를 포함한다.

| 코드 | 의미 | 예시 |
|------|------|------|
| `F1` | 엔티티 혼동 | 다른 회사와 혼동, ticker mismatch |
| `F2` | 시간축 오류 | 과거/최신 정보 혼용, 발표일/효력일 혼동 |
| `F3` | 숫자 오류 | 금액·비율·단위 오류 |
| `F4` | 이벤트 귀속 오류 | 주체/대상 기업 뒤바뀜 |
| `F5` | 근거 누락 | citation 부족, 반대 근거 누락 |
| `F6` | 추론 과장 | 상관관계를 인과로 단정 |
| `F7` | 안전성 오류 | 투자 권유, 리스크 경고 누락 |
| `F8` | 과잉 방어 | 답할 수 있는 질문도 회피 |

이 taxonomy는 trace와 함께 저장되어야 다음 개선 루프에서 병목을 빠르게 찾을 수 있다.

---

## 6. Enum 정의

| Enum | 값 | 사용 위치 |
|------|-----|-----------|
| `SourceType` | filing, news, ir, analysis, government | 전체 파이프라인 |
| `DocStatus` | active, superseded, retracted, duplicate | CanonicalDocument |
| `ResolutionStatus` | resolved, placeholder, unresolved | ResolvedMention |
| `Factuality` | fact, interpretation, rumor, unknown | EventCandidate, CanonicalEvent |
| `Certainty` | disclosed, reported, estimated, speculated | EventCandidate, CanonicalEvent |
| `Polarity` | positive, negative, neutral, mixed | EventCandidate, CanonicalEvent |

---

## 7. 설계 의사결정 근거

**왜 Pydantic v2를 사용하는가?**
Pydantic v2는 `model_dump(mode="json")`으로 datetime·Enum을 포함한 전체 스키마를 JSON 직렬화할 수 있다. 체크포인트 저장(`save_step1`, `save_graph`)과 로드 시 별도 직렬화 로직이 필요 없다.

**왜 ID prefix를 타입별로 구분하는가?**
`raw_`, `canon_`, `evt_cand_`, `canon_evt_`, `men_`, `passage_` 등 prefix를 붙이면 로그·디버깅 시 ID만 보고도 어느 단계의 객체인지 즉시 식별 가능하다. prefix 없는 UUID는 파이프라인 전반에 걸쳐 추적하기 어렵다.

**왜 trace / eval / run schema를 따로 두는가?**
코어 스키마만으로는 "무엇이 만들어졌는가"는 보이지만 "왜 이 결과가 나왔는가"는 남지 않는다. 하네스 엔지니어링에서는 trace와 run metadata가 개선 루프의 핵심이므로 별도 스키마로 관리해야 한다.
