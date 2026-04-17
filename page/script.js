/* =============================================
   F-KG Landing Page — Interactions
   ============================================= */

/* ----- i18n Translations ----- */
const TRANSLATIONS = {
  ko: {
    'nav-problem': 'Problem',
    'nav-demo': 'Demo',
    'hero-title': '금융 AI 에이전트',
    'hero-subtitle': '분산된 금융 정보를 지식그래프로 통합해<br>근거&middot;인과 검증 기반 답변을 생성하는<br><strong>Agentic GraphRAG 시스템</strong>',
    'wall-title': '일반 RAG는 금융에서 왜 실패하는가',
    'wall-desc': '텍스트 청크 기반 검색은 관계, 인과, 시간축을 놓칩니다',
    'wall-problem-header': '일반 RAG의 한계',
    'wall-p1-title': '관계 표현 불가',
    'wall-p1-desc': '기업-계열사-공급망-규제의 다단계 연결을 텍스트 청크로 전달하면 LLM이 관계 추론에 과도하게 의존',
    'wall-p2-title': '멀티홉 추론 한계',
    'wall-p2-desc': '"이 정책이 어떤 산업을 거쳐 어떤 기업에 영향을 미치는가" 같은 다단계 질의에 부적합',
    'wall-p3-title': '컨텍스트 오염',
    'wall-p3-desc': '관련 문서와 무관한 정보가 함께 입력되어 응답 품질이 불안정',
    'wall-p4-title': '실패 원인 추적 불가',
    'wall-p4-desc': '파이프라인이 복잡해질수록 "어디서 틀렸는가"를 분해하지 못함',
    'wall-p5-title': '투자 표현 제어 없음',
    'wall-p5-desc': '금융 규제에 맞는 안전성 필터가 없어 위험한 표현이 그대로 출력',
    'wall-solution-header': '이 시스템의 접근',
    'wall-s1-title': '그래프 엣지로 관계 보존',
    'wall-s1-desc': 'Knowledge Graph로 기업-산업-이벤트 관계를 구조화',
    'wall-s2-title': 'Sub-graph Retrieval',
    'wall-s2-desc': '관련 노드만 정밀 추출하여 다단계 탐색',
    'wall-s3-title': '관련 노드만 정밀 추출',
    'wall-s3-desc': 'Seed 탐색 + Hop 전략으로 노이즈 차단',
    'wall-s4-title': 'F1~F8 Taxonomy + Trace',
    'wall-s4-desc': '8가지 실패 유형 분류와 단계별 Trace 수집',
    'wall-s5-title': 'Risk Controller 레이어',
    'wall-s5-desc': '투자 권유, 과신 표현을 자동 감지 및 필터링',
    'pipeline-title': '이중 파이프라인 구조',
    'pipeline-desc': '오프라인 KG 구축과 온라인 질의 처리를 분리하고, 하네스가 양쪽을 감시합니다',
    'pipeline-offline-label': '상시 실행',
    'pipeline-off1-title': '문서 수집',
    'pipeline-off2-title': '전처리 &amp; NER',
    'pipeline-off2-desc': '문장분리 &rarr; NER &rarr; 타입분류',
    'pipeline-off4-title': '이벤트 추출',
    'pipeline-off4-desc': 'Event Frame + 중복 병합',
    'pipeline-off5-title': 'KG 적재',
    'pipeline-online-label': '질의 시 실행',
    'pipeline-on1-desc': '자연어 &rarr; 구조화된 QueryPlan',
    'pipeline-on2-desc': 'KG에서 관련 Sub-graph 추출',
    'pipeline-on3-desc': '시간순 &middot; 인과 재구성',
    'pipeline-on4-desc': 'citation 정렬 + 답변 구성',
    'pipeline-on5-desc': '안전성 필터링 &rarr; StructuredAnswer',
    'agents-title': '에이전트 파이프라인',
    'agents-desc': '각 에이전트는 독립된 입력/출력/성공 조건/실패 조건을 가집니다',
    'agent1-desc': '자연어 질의를 intent, entity, temporal scope로 분해',
    'agent2-desc': 'Seed 탐색, hop/edge 전략으로 관련 서브그래프 추출',
    'agent3-desc': 'PassageIndex 기반 원문 근거 회수 + 상충 탐지',
    'agent4-desc': '시간순 정렬, 인과 연결, unsupported inference 점검',
    'agent5-desc': 'unsupported claim, contradiction, 시간 역전 검증',
    'agent6-desc': '사실/해석 구분, citation alignment, confidence 산출',
    'agent7-desc': '투자 권유, 과도한 확신, 리스크 경고 누락 필터링',
    'harness-title': '4-Layer 하네스 시스템',
    'harness-desc': 'AI Agent가 인간 개입 없이도 안정적으로 동작하도록 감시하는 운영 계층',
    'harness1-purpose': '에이전트의 행동 경계 정의',
    'harness1-tag1': '투자 권유 금지',
    'harness1-tag2': '무근거 인과 단정 금지',
    'harness1-tag3': '허용된 tool 범위 제한',
    'harness2-purpose': '항상 참조하는 기준 정보 구조화',
    'harness3-purpose': '출력 검증과 자동 평가',
    'harness4-purpose': '실패 후 원인 분석과 self-repair',
    'harness4-tag1': 'trace 분석',
    'harness4-tag2': '재시도',
    'harness4-tag3': '회귀 감지',
    'harness4-tag4': '규칙/프롬프트 업데이트',
    'trust-title': '금융 도메인 특화 설계',
    'trust1-title': '5-Tier 출처 신뢰도',
    'trust1-desc': '모든 Evidence에 출처 등급을 부여합니다',
    'tier1-label': '공시 (1등급)',
    'tier1-note': '가장 신뢰',
    'tier2-label': 'IR (2등급)',
    'tier3-label': '뉴스 (3등급)',
    'tier4-label': '분석 (4등급)',
    'tier5-label': '루머 (5등급)',
    'tier5-note': '필터 대상',
    'trust2-title': '온톨로지 기반 Hierarchical Graph',
    'trust2-desc': '금융 데이터의 성격에 따라 3계층으로 분리 설계 — 탐색 효율 · 독립 업데이트 · 출처 역추적을 구조로 해결',
    'kgh-tag1': 'Multi-hop 탐색 최적화',
    'kgh-tag2': '레이어별 독립 업데이트',
    'kgh-tag3': '할루시네이션 구조적 방지',
    'hier1-name': 'Static Nodes',
    'hier1-freq': '구조 고정',
    'hier2-name': 'Event Nodes',
    'hier2-freq': '실시간 수집',
    'hier3-name': 'Evidence Nodes',
    'hier3-freq': '출처 역추적',
    'kgh-n1a': '현대차',
    'kgh-n1b': '자동차산업',
    'kgh-n2a': '신공장 건설 계약 체결',
    'kgh-n3a': 'DART 공시 원문',
    'kgh-n3b': '연합뉴스 기사',
    'taxonomy-title': '금융 특화 오류 분류 체계',
    'taxonomy-desc': '금융 AI가 만들 수 있는 8가지 실패 유형을 사전 정의하고, 각 단계에서 감지합니다',
    'f1-title': '엔티티 혼동',
    'f1-desc': '현대차 &ne; 현대모비스<br>계열사/본사 혼동, ticker mismatch',
    'f2-title': '시간축 오류',
    'f2-desc': '발표일 &ne; 효력일<br>최신 정보 대신 과거 정보 사용',
    'f3-title': '숫자 오류',
    'f3-desc': '절대값 &ne; 증감률<br>금액/비율/단위 오류',
    'f4-title': '이벤트 귀속',
    'f4-desc': '주체 기업 &ne; 대상 기업<br>행위자와 영향받는 기업 뒤바뀜',
    'f5-title': '근거 누락',
    'f5-desc': '핵심 citation 부족<br>반대 evidence 누락',
    'f6-title': '추론 과장',
    'f6-desc': '상관관계 &rarr; 인과 단정<br>가능성을 사실처럼 표현',
    'f7-title': '안전성 오류',
    'f7-desc': '투자 권유, 과도한 확신<br>리스크 경고 누락',
    'f8-title': '과잉 방어',
    'f8-desc': '답할 수 있는 질문도 회피<br>유용성 훼손',
    'querytypes-title': '4가지 질의 유형',
    'tab-fact': '사실 조회',
    'tab-relation': '관계 추론',
    'tab-temporal': '시간축 추적',
    'tab-decision': '의사결정 지원',
    'fact-q': 'Q: "현대차에 최근 어떤 이벤트가 있었는가?"',
    'fact-flow1': 'Company(현대차) seed 탐색',
    'fact-flow2': '연결된 Event 노드 수집',
    'fact-flow3': '시간순 정렬 + Evidence 반환',
    'fact-desc': '특정 기업 또는 산업에 일어난 사실 기반 질의. KG에서 직접 조회 가능한 정보를 반환합니다.',
    'relation-q': 'Q: "이 이벤트가 어떤 기업군에 전이될 가능성이 있는가?"',
    'relation-flow1': '멀티홉 서브그래프',
    'relation-flow2': '관계 기반 추론',
    'relation-desc': '엔티티 간 구조적 관계를 다단계로 탐색. 공급망, 경쟁구도, 정책 수혜/피해 관계를 파악합니다.',
    'temporal-q': 'Q: "어떤 이벤트가 먼저 발생했고, 이후 무엇이 연쇄적으로 이어졌는가?"',
    'temporal-flow1': '타임라인 정렬',
    'temporal-flow2': '패턴 비교',
    'temporal-desc': '이벤트의 시간 연쇄와 패턴 추적. 과거 유사 이벤트와 비교하여 전개 방향을 분석합니다.',
    'decision-q': 'Q: "지금 시장에서 핵심 촉발 요인은 무엇인가?"',
    'decision-flow1': '전체 KG 스캔',
    'decision-flow2': '고빈도 Event 클러스터',
    'decision-flow3': '영향 범위 산출',
    'decision-flow4': '우선순위 랭킹',
    'decision-desc': '복합 분석이 필요한 고수준 질의. 여러 에이전트가 협업하여 의사결정 근거를 구성합니다.',
    'repair-title': 'AI가 틀리면, 스스로 감지하고 고칩니다',
    'repair-desc': '실패 시 self-repair &rarr; safe fallback &rarr; human escalation 순으로 대응',
    'repair-perceive': '위험 컨텍스트 확인',
    'repair-plan': 'QueryPlan 생성',
    'repair-act': '7 에이전트 실행',
    'repair-observe': '4가지 검증',
    'repair-pass': '최종 응답 반환',
    'repair-reflect': 'F1~F8 분류',
    'repair-iterate': 'KG 보완 &rarr; 재시도',
    'escalation1-desc': 'KG 보완 수집 &rarr; 파이프라인 재실행',
    'escalation2-desc': '불확실한 부분 명시 &rarr; 부분 응답',
    'escalation3-desc': '고위험 판단 &rarr; 인간 검토 요청',
    'inference-title': '실제 질의 응답 예시',
    'demo-q': '기아의 최근 주요 이벤트와 관련 기업을 알려줘',
    'demo-a': '최근 기아는 여러 중요한 이벤트들이 있었습니다. 서울 교통약자에 대한 지원 프로그램을 시작하며, 전기차 관련 협약을 체결하고, 전기차 충전 시설 확대를 위한 서울시와의 업무협약을 맺었습니다. 기아는 또한 전기차 전용 타이어를 공급하는 한국타이어와 협력하여 전기차 시장에 더욱 박차를 가하고 있습니다. 이러한 이벤트들은 기아의 전기차 전환 전략을 강화하는 데 큰 역할을 하고 있습니다.',
    'meta-companies': '관련 기업',
    'meta-company1': '현대자동차',
    'meta-company2': '보스턴 다이내믹스',
    'meta-timeline': '타임라인',
    'meta-events': '5개 이벤트',
    'meta-sources': '출처',
    'meta-source-count': '12건',
    'source-toggle': '출처 보기 &#x25BC;',
    'source1': 'DART 공시 &mdash; 기아 전기차 충전 인프라 업무협약 (2025-03)',
    'source2': '뉴스 &mdash; 기아, 서울시 교통약자 지원 프로그램 발표 (2025-02)',
    'source3': '뉴스 &mdash; 한국타이어, 기아 전기차 전용 타이어 공급 계약 (2025-01)',
    'source-more': '... 외 9건',
    'meta-confidence': '신뢰도',
    'meta-warning': '이 답변은 투자 권유가 아닙니다. AI 생성 콘텐츠로, 투자 결정 시 전문가 상담을 권장합니다.',
    'kg-title': '실제 구축된 금융 지식 그래프',
    'kg-desc': 'DART 공시&middot;뉴스에서 추출한 엔티티와 관계 &mdash; max 200 nodes',
    'kg-viewer-title': '금융 지식그래프',
    'kg-loading': '그래프 로딩 중...',
    'kg-fit': '전체 보기',
    'kg-physics-pause': '물리 시뮬레이션 일시정지',
    'kg-physics-resume': '물리 시뮬레이션 재개',
    'story-title': '왜 만들었는가',
    'story1-title': '일반 RAG로 금융 질문을 던져보았습니다',
    'story1-desc': '기업 혼동, 시간 오류, 근거 없는 인과 추론 &mdash; 금융 도메인에서 텍스트 기반 RAG는 예상보다 자주 틀렸고, 왜 틀렸는지 추적할 방법이 없었습니다.',
    'story2-title': '지식 그래프 + 하네스 엔지니어링을 조합했습니다',
    'story2-desc': '텍스트를 구조화된 지식으로 변환하고, 에이전트의 행동을 Constraint&middot;Context&middot;Verification&middot;Feedback Loop 4계층으로 감시하는 시스템을 설계했습니다.',
    'story3-title': 'AI가 틀리는 것보다, 왜 틀렸는지 모르는 것이 더 위험합니다',
    'story3-desc': '이 시스템의 핵심은 "틀리지 않는 AI"가 아닙니다. 실패를 감지하고, 분류하고, 스스로 복구하거나, 적절한 시점에 인간에게 넘기는 것입니다.',
  },
  en: {
    'nav-problem': 'Problem',
    'nav-demo': 'Demo',
    'hero-title': 'Financial AI Agent',
    'hero-subtitle': 'Integrating distributed financial data into a knowledge graph<br>to generate answers grounded in evidence &amp; causal verification &mdash;<br><strong>Agentic GraphRAG System</strong>',
    'wall-title': 'Why Does General RAG Fail in Finance?',
    'wall-desc': 'Text chunk-based retrieval misses relationships, causality, and temporal context',
    'wall-problem-header': 'Limitations of General RAG',
    'wall-p1-title': 'Cannot Represent Relationships',
    'wall-p1-desc': 'Multi-level connections between companies, subsidiaries, supply chains, and regulations lose relational meaning when flattened to text chunks',
    'wall-p2-title': 'Multi-hop Reasoning Limitations',
    'wall-p2-desc': 'Multi-step queries like "Which companies are affected through which industries by this policy?" are poorly handled',
    'wall-p3-title': 'Context Contamination',
    'wall-p3-desc': 'Irrelevant information mixed in with relevant documents leads to unstable response quality',
    'wall-p4-title': 'Cannot Trace Failure Causes',
    'wall-p4-desc': 'As pipelines grow complex, there is no way to decompose "where did it go wrong?"',
    'wall-p5-title': 'No Investment Expression Control',
    'wall-p5-desc': 'Without safety filters aligned to financial regulations, risky expressions appear in outputs as-is',
    'wall-solution-header': "This System's Approach",
    'wall-s1-title': 'Preserve Relationships via Graph Edges',
    'wall-s1-desc': 'Knowledge Graph structures company–industry–event relationships',
    'wall-s2-title': 'Sub-graph Retrieval',
    'wall-s2-desc': 'Precisely extract only relevant nodes for multi-hop traversal',
    'wall-s3-title': 'Precise Node Extraction',
    'wall-s3-desc': 'Seed search + Hop strategy to block noise',
    'wall-s4-title': 'F1–F8 Taxonomy + Trace',
    'wall-s4-desc': '8-type failure classification with per-step trace collection',
    'wall-s5-title': 'Risk Controller Layer',
    'wall-s5-desc': 'Automatically detects and filters investment solicitation and overconfident expressions',
    'pipeline-title': 'Dual Pipeline Architecture',
    'pipeline-desc': 'Offline KG construction and online query processing are separated, with the harness monitoring both sides',
    'pipeline-offline-label': 'Always Running',
    'pipeline-off1-title': 'Document Collection',
    'pipeline-off2-title': 'Preprocessing &amp; NER',
    'pipeline-off2-desc': 'Sentence split &rarr; NER &rarr; Type classification',
    'pipeline-off4-title': 'Event Extraction',
    'pipeline-off4-desc': 'Event Frame + deduplication merge',
    'pipeline-off5-title': 'Knowledge Graph Loading',
    'pipeline-online-label': 'On-Query Execution',
    'pipeline-on1-desc': 'Natural language &rarr; Structured QueryPlan',
    'pipeline-on2-desc': 'Extract relevant Sub-graph from KG',
    'pipeline-on3-desc': 'Temporal &amp; causal reconstruction',
    'pipeline-on4-desc': 'Citation alignment + answer construction',
    'pipeline-on5-desc': 'Safety filtering &rarr; StructuredAnswer',
    'agents-title': 'Agent Pipeline',
    'agents-desc': 'Each agent has independent input / output / success / failure conditions',
    'agent1-desc': 'Decomposes natural language queries into intent, entity, and temporal scope',
    'agent2-desc': 'Extracts relevant subgraphs via seed search and hop/edge strategies',
    'agent3-desc': 'PassageIndex-based source evidence retrieval + conflict detection',
    'agent4-desc': 'Temporal ordering, causal linking, and unsupported inference checking',
    'agent5-desc': 'Validates unsupported claims, contradictions, and temporal inversions',
    'agent6-desc': 'Fact/interpretation separation, citation alignment, confidence scoring',
    'agent7-desc': 'Filters investment solicitation, excessive confidence, and missing risk warnings',
    'harness-title': '4-Layer Harness System',
    'harness-desc': 'Operational layer that monitors AI Agents to operate reliably without human intervention',
    'harness1-purpose': 'Defines agent behavior boundaries',
    'harness1-tag1': 'No Investment Solicitation',
    'harness1-tag2': 'No Unsupported Causal Claims',
    'harness1-tag3': 'Restrict Allowed Tool Scope',
    'harness2-purpose': 'Structures reference information always consulted',
    'harness3-purpose': 'Output verification and automated evaluation',
    'harness4-purpose': 'Post-failure root cause analysis and self-repair',
    'harness4-tag1': 'trace analysis',
    'harness4-tag2': 'retry',
    'harness4-tag3': 'regression detection',
    'harness4-tag4': 'rule/prompt update',
    'trust-title': 'Finance Domain-Specific Design',
    'trust1-title': '5-Tier Source Credibility',
    'trust1-desc': 'Assigns a credibility tier to every piece of Evidence',
    'tier1-label': 'Disclosure (Tier 1)',
    'tier1-note': 'Most Trusted',
    'tier2-label': 'IR (Tier 2)',
    'tier3-label': 'News (Tier 3)',
    'tier4-label': 'Analysis (Tier 4)',
    'tier5-label': 'Rumor (Tier 5)',
    'tier5-note': 'Filter Target',
    'trust2-title': 'Ontology-based Hierarchical Graph',
    'trust2-desc': '3-layer separation by financial data nature — traversal efficiency, independent updates & source tracing built into structure',
    'kgh-tag1': 'Multi-hop Traversal Optimization',
    'kgh-tag2': 'Independent Layer Updates',
    'kgh-tag3': 'Structural Hallucination Prevention',
    'hier1-name': 'Static Nodes',
    'hier1-freq': 'Fixed Structure',
    'hier2-name': 'Event Nodes',
    'hier2-freq': 'Real-time Collection',
    'hier3-name': 'Evidence Nodes',
    'hier3-freq': 'Source Tracing',
    'kgh-n1a': 'Hyundai',
    'kgh-n1b': 'Auto Industry',
    'kgh-n2a': 'New Plant Contract Signed',
    'kgh-n3a': 'DART Filing',
    'kgh-n3b': 'News Article',
    'taxonomy-title': 'Finance-Specific Failure Taxonomy',
    'taxonomy-desc': 'Pre-defines 8 failure types financial AI can produce and detects them at each stage',
    'f1-title': 'Entity Confusion',
    'f1-desc': 'Hyundai &ne; Hyundai Mobis<br>Subsidiary/parent confusion, ticker mismatch',
    'f2-title': 'Temporal Error',
    'f2-desc': 'Announcement date &ne; effective date<br>Using outdated info instead of latest',
    'f3-title': 'Numeric Error',
    'f3-desc': 'Absolute value &ne; growth rate<br>Amount / ratio / unit errors',
    'f4-title': 'Event Attribution Error',
    'f4-desc': 'Acting company &ne; target company<br>Actor and affected company swapped',
    'f5-title': 'Missing Evidence',
    'f5-desc': 'Insufficient key citations<br>Missing counter-evidence',
    'f6-title': 'Inference Overreach',
    'f6-desc': 'Correlation &rarr; causal assertion<br>Possibility expressed as fact',
    'f7-title': 'Safety Error',
    'f7-desc': 'Investment solicitation, excessive confidence<br>Missing risk warnings',
    'f8-title': 'Over-Defense',
    'f8-desc': 'Avoids answerable questions<br>Degrades usefulness',
    'querytypes-title': '4 Query Types',
    'tab-fact': 'Fact Lookup',
    'tab-relation': 'Relation Inference',
    'tab-temporal': 'Temporal Tracking',
    'tab-decision': 'Decision Support',
    'fact-q': 'Q: "What recent events have occurred at Hyundai Motor?"',
    'fact-flow1': 'Company(Hyundai) seed search',
    'fact-flow2': 'Collect connected Event nodes',
    'fact-flow3': 'Temporal Sorting + Evidence Return',
    'fact-desc': 'Fact-based queries about a specific company or industry. Returns information directly queryable from the KG.',
    'relation-q': 'Q: "Which company groups could this event propagate to?"',
    'relation-flow1': 'Multi-hop Subgraph Retrieval',
    'relation-flow2': 'Relationship-based Inference',
    'relation-desc': 'Multi-step traversal of structural relationships between entities. Identifies supply chain, competitive, and policy beneficiary/victim relationships.',
    'temporal-q': 'Q: "Which event occurred first, and what followed in sequence?"',
    'temporal-flow1': 'Timeline Ordering',
    'temporal-flow2': 'Pattern Comparison',
    'temporal-desc': 'Tracks event temporal chains and patterns. Analyzes trajectory by comparing with past similar events.',
    'decision-q': 'Q: "What are the key triggering factors in the market right now?"',
    'decision-flow1': 'Full KG scan',
    'decision-flow2': 'High-frequency Event clusters',
    'decision-flow3': 'Impact Scope Calculation',
    'decision-flow4': 'Priority Ranking',
    'decision-desc': 'High-level queries requiring complex analysis. Multiple agents collaborate to construct decision-making rationale.',
    'repair-title': 'When AI Makes Mistakes, It Detects and Fixes Them',
    'repair-desc': 'On failure: self-repair &rarr; safe fallback &rarr; human escalation',
    'repair-perceive': 'Check risk context',
    'repair-plan': 'Generate QueryPlan',
    'repair-act': 'Run 7 agents',
    'repair-observe': '4 verifications',
    'repair-pass': 'Return final response',
    'repair-reflect': 'F1–F8 classification',
    'repair-iterate': 'KG supplement &rarr; retry',
    'escalation1-desc': 'Collect KG supplements &rarr; re-run pipeline',
    'escalation2-desc': 'Explicitly mark uncertain parts &rarr; partial response',
    'escalation3-desc': 'High-risk judgment &rarr; request human review',
    'inference-title': 'Live Query Response Example',
    'demo-q': "Tell me about Kia's recent major events and related companies",
    'demo-a': "Kia has had several significant events recently. The company launched a mobility support program for transportation-disadvantaged residents in Seoul, signed EV-related agreements, and established a partnership with the Seoul Metropolitan Government to expand EV charging infrastructure. Kia is also accelerating its push into the EV market through collaboration with Hankook Tire, which will supply EV-dedicated tires. These events play a significant role in strengthening Kia's EV transition strategy.",
    'meta-companies': 'Related Companies',
    'meta-company1': 'Hyundai Motor',
    'meta-company2': 'Hankook Tire',
    'meta-timeline': 'Timeline',
    'meta-events': '5 Events',
    'meta-sources': 'Sources',
    'meta-source-count': '12 items',
    'source-toggle': 'Show Sources &#x25BC;',
    'source1': 'DART Filing &mdash; Kia EV Charging Infrastructure MOU (2025-03)',
    'source2': 'News &mdash; Kia Announces Seoul Mobility Support Program (2025-02)',
    'source3': 'News &mdash; Hankook Tire Signs EV-Dedicated Tire Supply Agreement with Kia (2025-01)',
    'source-more': '... and 9 more',
    'meta-confidence': 'Confidence',
    'meta-warning': 'This answer is not investment advice. This is AI-generated content. Professional consultation is recommended for investment decisions.',
    'kg-title': 'Financial Knowledge Graph in Production',
    'kg-desc': 'Entities and relationships extracted from DART filings &amp; news &mdash; max 200 nodes',
    'kg-viewer-title': 'Financial Knowledge Graph',
    'kg-loading': 'Loading graph...',
    'kg-fit': 'Fit All',
    'kg-physics-pause': 'Pause Physics',
    'kg-physics-resume': 'Resume Physics',
    'story-title': 'Why I Built This',
    'story1-title': 'I Tried General RAG for Financial Questions',
    'story1-desc': 'Company confusion, temporal errors, unsupported causal reasoning &mdash; text-based RAG failed more often than expected in the financial domain, with no way to trace why.',
    'story2-title': 'I Combined Knowledge Graphs + Harness Engineering',
    'story2-desc': 'I designed a system that transforms text into structured knowledge and monitors agent behavior through 4 layers: Constraint, Context, Verification, and Feedback Loop.',
    'story3-title': 'Not Knowing Why AI Is Wrong Is More Dangerous Than the Error Itself',
    'story3-desc': 'The core of this system is not "an AI that never makes mistakes." It is detecting, classifying, and self-repairing failures &mdash; or escalating to humans at the right moment.',
  }
};

let currentLang = localStorage.getItem('lang') || 'ko';

function applySiteConfig() {
  const config = window.SITE_CONFIG || {};
  const linkMap = {
    repo: config.repoUrl,
    docs: config.docsUrl,
    author: config.authorUrl,
  };

  document.querySelectorAll('[data-site-link]').forEach((el) => {
    const key = el.dataset.siteLink;
    const href = linkMap[key];
    if (href) el.href = href;
  });
}

function setLang(lang) {
  currentLang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const text = TRANSLATIONS[lang][key];
    if (text !== undefined) el.innerHTML = text;
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  document.documentElement.lang = lang;
  localStorage.setItem('lang', lang);
}


/* ----- Knowledge Graph (vis.js) ----- */
function initKnowledgeGraph() {
  const container = document.getElementById('kg-network');
  const loading   = document.getElementById('kg-loading');
  const fitBtn    = document.getElementById('kg-fit');
  const physBtn   = document.getElementById('kg-physics-toggle');
  const statsBar  = document.getElementById('kg-stats-bar');

  if (!container) return;

  // kg_data_inline.js 가 <script>로 로드되어 window.KG_DATA 에 데이터가 있음
  const data = window.KG_DATA;
  if (!data) {
    if (loading) loading.innerHTML = '<span style="color:#ef4444">그래프 데이터 없음 — kg_data_inline.js 를 확인하세요.</span>';
    return;
  }

  const options = {
    physics: {
      enabled: true,
      forceAtlas2Based: {
        gravitationalConstant: -55,
        centralGravity: 0.015,
        springLength: 130,
        springConstant: 0.06,
        damping: 0.45,
      },
      solver: 'forceAtlas2Based',
      stabilization: { iterations: 200, updateInterval: 10 },
    },
    interaction: {
      hover: false,
      tooltipDelay: 80,
      zoomView: true,
      dragNodes: true,
      navigationButtons: false,
    },
    edges: {
      smooth: { type: 'curvedCW', roundness: 0.2 },
      font: { size: 9, color: '#aaaaaa', strokeWidth: 0, align: 'middle' },
    },
    nodes: {
      font: { color: '#ffffff', size: 12, strokeWidth: 2, strokeColor: '#1a1a2e' },
    },
  };

  const network = new vis.Network(
    container,
    { nodes: new vis.DataSet(data.nodes), edges: new vis.DataSet(data.edges) },
    options
  );

  network.on('stabilizationProgress', (params) => {
    if (loading) {
      const pct = Math.round((params.iterations / params.total) * 100);
      const span = loading.querySelector('span');
      const label = currentLang === 'en' ? 'Computing layout...' : '레이아웃 계산 중...';
      if (span) span.textContent = `${label} ${pct}%`;
    }
  });

  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { stabilization: false } });
    if (loading) loading.classList.add('hidden');
    network.fit({ animation: { duration: 800, easingFunction: 'easeInOutQuad' } });

    // Stats bar
    if (statsBar && data.stats) {
      const s = data.stats;
      statsBar.innerHTML = Object.entries(s)
        .map(([k, v]) => `<span><strong>${v}</strong> ${k}</span>`)
        .join('');
    }
  });

  // Controls
  let physicsOn = true;
  if (fitBtn)   fitBtn.addEventListener('click', () => network.fit({ animation: true }));
  if (physBtn)  physBtn.addEventListener('click', () => {
    physicsOn = !physicsOn;
    network.setOptions({ physics: { enabled: physicsOn } });
    const pauseKey = physicsOn ? 'kg-physics-pause' : 'kg-physics-resume';
    physBtn.innerHTML = TRANSLATIONS[currentLang][pauseKey];
  });
}

initKnowledgeGraph();

document.addEventListener('DOMContentLoaded', () => {
  applySiteConfig();

  /* ----- Language toggle ----- */
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });

  // Apply saved or default language on load
  if (currentLang !== 'ko') setLang(currentLang);

  /* ----- Tab switching ----- */
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`[data-panel="${target}"]`).classList.add('active');
    });
  });

  /* ----- Source toggle ----- */
  const sourceToggle = document.getElementById('sourceToggle');
  const sourceList = document.getElementById('sourceList');
  if (sourceToggle && sourceList) {
    sourceToggle.addEventListener('click', () => {
      sourceList.classList.toggle('open');
      if (sourceList.classList.contains('open')) {
        sourceToggle.innerHTML = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&#x25B2;';
      } else {
        sourceToggle.innerHTML = TRANSLATIONS[currentLang]['source-toggle'];
      }
    });
  }

  /* ----- Stat counter animation ----- */
  const animateCounters = () => {
    document.querySelectorAll('.stat-number').forEach(el => {
      const target = parseInt(el.dataset.target, 10);
      if (isNaN(target)) return;
      let current = 0;
      const step = Math.ceil(target / 20);
      const interval = setInterval(() => {
        current += step;
        if (current >= target) {
          current = target;
          clearInterval(interval);
        }
        el.textContent = current;
      }, 40);
    });
  };

  /* ----- Confidence bar animation ----- */
  const animateConfidence = () => {
    document.querySelectorAll('.confidence-fill').forEach(bar => {
      const val = bar.dataset.confidence;
      if (val) bar.style.width = val + '%';
    });
  };

  /* ----- Scroll-triggered animations ----- */
  const fadeEls = document.querySelectorAll('.section-tag, .section-title, .section-desc, ' +
    '.compare-item, .pipeline-card, .agent-card, .harness-layer, .trust-card, ' +
    '.taxonomy-card, .tab-example, .repair-step, .escalation-item, .inference-card, ' +
    '.kg-viewer, .story-step');

  fadeEls.forEach(el => el.classList.add('fade-in'));

  let statsAnimated = false;
  let confidenceAnimated = false;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');

        // Trigger stat counters once
        if (!statsAnimated && entry.target.closest('.stats')) {
          statsAnimated = true;
          animateCounters();
        }

        // Trigger confidence bar once
        if (!confidenceAnimated && entry.target.closest('.inference')) {
          confidenceAnimated = true;
          animateConfidence();
        }
      }
    });
  }, { threshold: 0.15 });

  fadeEls.forEach(el => observer.observe(el));

  // Also observe stats and inference sections directly
  const statsSection = document.getElementById('stats');
  const inferenceSection = document.getElementById('inference');
  if (statsSection) {
    statsSection.classList.add('fade-in');
    observer.observe(statsSection);
  }
  if (inferenceSection) observer.observe(inferenceSection);

  /* ----- Nav scroll effect ----- */
  const nav = document.getElementById('nav');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      nav.style.background = 'rgba(10, 15, 30, 0.95)';
    } else {
      nav.style.background = 'rgba(10, 15, 30, 0.85)';
    }
  });

});
