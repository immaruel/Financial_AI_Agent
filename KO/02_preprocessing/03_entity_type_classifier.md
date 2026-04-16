# 03. 엔티티 타입 분류 (Entity Type Classifier)

## 1. 목적

NER 단계에서 추출된 `MentionSpan`에 금융 KG 엔티티 타입을 확정한다. 확정된 타입은 이후 Entity Resolution 단계에서 어떤 사전·알고리즘으로 해소할지를 결정하는 분기 키가 된다.

**현재 구현 우선순위**: Reference Exact Match → Fuzzy Match → Context Rule

LLM fallback은 설계상 유효한 확장 옵션이지만, 현재 구현의 기본 경로는 rule/reference 기반 분류에 집중한다.

---

## 2. 입력 / 출력

### 입력

| 항목 | 설명 |
|------|------|
| `Dict[doc_id, List[MentionSpan]]` | NER 추출 결과 |
| `Dict[doc_id, PreprocessedDocument]` | 문장 컨텍스트 참조용 |
| `ReferenceDataManager` | 상장사·산업·기관 사전 |
| `EntityTypingConfig` | confidence 임계값, 허용 타입 목록 |

### 출력

`Dict[canonical_doc_id, List[TypedMention]]`

`TypedMention` 구조:

| 필드 | 타입 | 설명 |
|------|------|------|
| `mention_id` | str | 원본 MentionSpan ID 승계 |
| `mention_text` | str | 원문 텍스트 |
| `sentence_id` | str | 출처 문장 ID |
| `entity_type` | str | 확정된 엔티티 타입 |
| `type_confidence` | float | 타입 확정 confidence |
| `type_method` | str | 확정 방법 식별자 |

---

## 3. 처리 로직

### 허용 엔티티 타입 목록

```python
allowed_entity_types = [
    "Company", "Industry", "Institution", "Region", "Country",
    "Commodity", "Currency", "Index", "Policy", "Person",
    "MoneyAmount", "Percentage", "Date", "Quantity",
    "EventTrigger", "CounterpartyPlaceholder",
]
```

### 3.1 Reference Exact Match

`ReferenceDataManager`의 각 사전에서 `mention_text`를 정확하게 검색한다.

```
mention_text가 company_names에 포함  → entity_type="Company",   confidence=0.80
mention_text가 industry_names에 포함 → entity_type="Industry",  confidence=0.80
mention_text가 institution_names에 포함 → entity_type="Institution", confidence=0.80
...
```

`type_method = "reference_exact_match"`

### 3.2 Fuzzy Match

Exact Match 실패 시 `rapidfuzz`로 퍼지 매칭을 시도한다.

```python
score = fuzz.ratio(mention_text, candidate_name)
if score >= fuzzy_match_threshold:  # 기본값: 80
    entity_type = candidate_type
    confidence = fuzzy_match_confidence  # 기본값: 0.80
```

`type_method = "fuzzy_match"`

### 3.3 Context Rule

`mention_source`가 `rule_parser`인 경우 문맥 없이 타입을 확정한다.

```
mention_source == "rule_parser" + 금액 패턴  → "MoneyAmount"
mention_source == "rule_parser" + 날짜 패턴  → "Date"
mention_source == "rule_parser" + 퍼센트 패턴 → "Percentage"
mention_source == "trigger_lexicon"          → "EventTrigger"
mention_source == "placeholder_pattern"      → "CounterpartyPlaceholder"
```

`type_method = "context_rule"`, `confidence = 0.80`

### 3.4 LLM Fallback (하네스 확장 설계)

향후 하네스 엔지니어링 관점에서 저신뢰 mention을 줄이기 위해, 아래와 같은 선택적 LLM fallback을 붙일 수 있다.

```
입력: mention_text + 전후 문장 컨텍스트 + 허용 타입 목록
출력: {"entity_type": "...", "confidence": 0.xx}
```

적용 조건 예:

- rule / reference로 타입이 확정되지 않음
- ambiguity가 높은 기업 alias
- evaluation harness에서 해당 slice의 분류 품질이 병목으로 확인됨

LLM fallback을 도입할 경우에도 JSON 구조화 출력, 허용 타입 검증, confidence gate를 반드시 함께 둔다.

---

## 4. 의존성 및 연계 모듈

### Upstream
- `ner_extractor.py` → `MentionSpan` 리스트
- `doc_preprocessor.py` → `PreprocessedDocument` (컨텍스트 참조)
- `reference/company_data.py` → 사전

### Downstream
- `entity_resolver.py` → `TypedMention`을 받아 canonical entity로 해소

### 외부 의존성
- `rapidfuzz`: 퍼지 매칭 (`fuzz.ratio`)
- `QwenLLMClient` (utils/llm_client.py): 향후 low-confidence fallback 확장 시 사용 가능
- `EntityTypingConfig` (config/settings.py)

---

## 5. 데이터 흐름 내 위치

```
[NER Extractor]
        │  Dict[doc_id, List[MentionSpan]]
        ▼
[Entity Type Classifier]   ← 이 문서
        │  Dict[doc_id, List[TypedMention]]
        ▼
[Entity Resolver]
```

---

## 6. 구현 기준 설계

### Confidence 기반 분기 흐름

```python
# 1. Exact Match
for candidate_name, candidate_type in reference_dict.items():
    if mention_text == candidate_name:
        return TypedMention(entity_type=candidate_type,
                            type_confidence=0.80,
                            type_method="reference_exact_match")

# 2. Fuzzy Match
best_score, best_type = fuzzy_search(mention_text, reference_dict)
if best_score >= config.fuzzy_match_threshold:
    return TypedMention(entity_type=best_type,
                        type_confidence=config.fuzzy_match_confidence,
                        type_method="fuzzy_match")

# 3. Context Rule
if mention.mention_source in ("rule_parser", "trigger_lexicon", "placeholder_pattern"):
    return TypedMention(...)

# 4. LLM Fallback (선택적 확장)
if current_confidence < config.llm_fallback_threshold:
    result = llm_client.classify_entity_type(mention_text, context)
    return TypedMention(type_method="llm_fallback", ...)
```

### 허용 타입 외 결과 처리

LLM fallback을 도입했을 때 `allowed_entity_types` 외 타입이 반환되면 해당 mention은 타입 미분류로 처리된다. 이후 Entity Resolution에서 보수적으로 스킵하거나 human review 대상으로 넘길 수 있다.

---

## 7. 설계 의사결정 근거

**왜 LLM을 fallback 옵션으로만 두는가?**
LLM 호출은 추론 시간과 GPU 메모리 비용이 크다. 공시·뉴스 문서의 대부분은 사전 Exact Match 또는 Context Rule로 타입이 확정 가능하다. 따라서 기본 경로는 rule/reference 기반으로 두고, 실제 병목이 확인된 경우에만 fallback을 추가하는 편이 운영상 유리하다.

**왜 confidence 임계값을 0.60으로 설정하는가?**
너무 높으면 LLM 호출이 과다해지고, 너무 낮으면 오분류 mention이 Entity Resolution까지 전달된다. 0.60은 사전 기반 confidence(0.80)와 완전 미지 상태(0.0) 사이에서 "규칙으로 어느 정도 확인됐지만 확신할 수 없는" 영역을 포착하는 경험적 임계값이다.
