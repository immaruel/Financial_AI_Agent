# 01. Document Ingestion

## 1. Purpose

Collect financial documents from external sources, specifically the DART filing API and the Naver News API, and store them as `RawDocument`.

The core goal of this module is not simple downloading, but **accurately tracking source, time, correction history, and duplication status**. It is the first gate that guarantees trustworthy source metadata for the downstream preprocessing pipeline.

---

## 2. Inputs / Outputs

### Input

| Item | Description |
|------|-------------|
| `CollectionConfig` | Full collection parameters such as polling cycle, lookback window, API keys, and search keywords |
| DART API endpoint | `https://opendart.fss.or.kr/api` |
| Naver News API endpoint | `https://openapi.naver.com/v1/search/news.json` |
| `company_names` | Full list of listed company names from DART, used for keyword-based news collection |

### Output

`RawDocument` (`utils/schemas.py`)

| Field | Type | Description |
|------|------|-------------|
| `raw_doc_id` | str | Internal UUID, prefix `raw_` |
| `source_type` | SourceType | `filing` / `news` |
| `source_url` | str | Source URL |
| `external_doc_id` | str | Source-specific ID, such as filing receipt number or news link |
| `original_title` | str | Original title |
| `raw_text` | str | Uncleaned body text |
| `original_timestamp` | datetime | Original publication time |
| `crawled_at` | datetime | Collection execution time |
| `rcept_no` | str (filing) | DART receipt number |
| `corp_code` | str (filing) | DART corporation code |
| `is_correction` | bool (filing) | Whether the filing is a correction filing |
| `parent_rcept_no` | str (filing) | Receipt number of the filing being corrected |

---

## 3. Processing Logic

### 3.1 CollectionOrchestrator

The top-level orchestrator in `source_connector.py`. It runs `DARTFilingConnector` and `NaverNewsConnector` in parallel and merges their outputs.

```python
class CollectionOrchestrator:
    async def collect_all(self) -> List[RawDocument]:
        # Run DARTFilingConnector and NaverNewsConnector concurrently
        results = await asyncio.gather(
            dart_connector.fetch_documents(),
            news_connector.fetch_documents(),
        )
        return flatten(results)
```

### 3.2 DART Filing Collection (`DARTFilingConnector`)

**Collection flow:**

```text
Paginate list.json (bgn_de ~ end_de, PAGE_SIZE=100)
      │
      ▼
Collect the full filing list
      │
      ▼
asyncio.gather + Semaphore(max_concurrent=10)
  └─ Run _fetch_single_filing() in parallel for each filing
      │
      ├─ If report type is in FULL_TEXT_REPORT_TYPES, also fetch body via document.json
      └─ Otherwise keep only title/metadata
```

**FULL_TEXT_REPORT_TYPES (filing categories collected with full body text):**

```text
material reports, earnings disclosures, supply contracts, rights offerings, treasury stock,
dividends, mergers, spin-offs, business transfers, stock swaps, large related-party transactions, executive changes
```

**Correction filing handling:**

- If the title contains correction keywords such as `정정`, `[정정]`, or `기재정정`, set `is_correction=True`
- Link the original receipt number through `parent_rcept_no`
- If the receipt number differs, always store it as a separate `RawDocument`

**Time parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `filing_lookback_days` | 3 days | Re-query the past 3 days on every run |
| `filing_poll_interval_sec` | 300 sec (5 min) | Interval for checking new filings |
| `filing_update_window_days` | 3 days | Allowed window for modifications to existing filings |

### 3.3 Naver News Collection (`NaverNewsConnector`)

**Collection flow:**

```text
news_search_keywords (default: 10 keywords such as Hyundai Motor, Samsung Electronics)
      │
      ▼
API call per keyword (display=news_display_count, default 100)
      │
      ▼
Parallel processing with asyncio.gather + Semaphore
      │
      ▼
Extract HTML body from source_url
      │
      ▼
Create RawDocument
```

**Time parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `news_lookback_hours` | 24 hours | Re-query the past 24 hours on every run |
| `news_poll_interval_sec` | 600 sec (10 min) | Interval for checking new articles |
| `news_update_window_days` | 3 days | Allowed window for modifications to existing news |
| `news_display_count` | 100 | Maximum number collected per keyword, which is the API upper bound |

---

## 4. Dependencies and Connected Modules

### Upstream

- `ReferenceDataManager` (`reference/company_data.py`): provides the full DART listed company list, which powers news collection keywords and the NER dictionary
- `CollectionConfig` (`config/settings.py`): all collection parameters

### Downstream

- `RawDocumentNormalizer` (`collection/raw_normalizer.py`): normalizes collected `RawDocument` into a common format
- `DocumentFingerprinter` (`collection/document_fingerprint.py`): determines duplicate and version status

### External Dependencies

- `aiohttp`: asynchronous HTTP client
- `asyncio.Semaphore`: concurrency limiter, `max_concurrent_requests=10`

---

## 5. Position in the Data Flow

```text
[External APIs] ──→ [Source Connector] ──→ [Raw Document Normalizer] ──→ [Document Fingerprinter]
                        ↑
               (The module covered by this document)
```

This is the first step of STEP 1. It forms the boundary between the external world and the internal pipeline.

---

## 6. Implementation Design Standards

### Asynchronous Processing Structure

Because network I/O is the bottleneck, all HTTP requests are handled through `aiohttp` and `asyncio.gather`. Ray is not applied because this stage has no meaningful CPU-heavy computation.

```python
async with aiohttp.ClientSession() as session:
    semaphore = asyncio.Semaphore(self.config.max_concurrent_requests)
    tasks = [self._fetch_single_filing(session, item, semaphore) for item in filing_list]
    results = await asyncio.gather(*tasks, return_exceptions=True)
```

`return_exceptions=True` prevents a single request failure from stopping the entire collection job.

### Multiple Time Fields

Time has multiple meanings in the finance domain.

| Field | Meaning |
|------|---------|
| `published_at` | Time when the document was published |
| `updated_at` | Time when the document was modified |
| `effective_at` | Time when the real effect starts, especially important for filings |
| `crawled_at` | Time when collection ran |
| `first_seen_at` | Time when the system first observed the document |

These fields are later referenced by Event Canonicalization and by time filtering in the agent pipeline.

### Source Reliability Tier (`trust_tier`)

At collection time, `trust_tier` is determined from `source_type`.

| trust_tier | Source type |
|------------|-------------|
| 1 | filing, exchange_notice, government |
| 2 | ir, official_release |
| 3 | news |
| 4 | analysis |
| 5 | rumor |

This value is later used by Event Canonicalization as a priority rule when choosing representative values.

### Real-Time Supplemental Collection on KG Miss

The `_online_supplement()` method in `main.py` calls this module directly again. In that case, it temporarily replaces `news_search_keywords` with query keywords and limits the collection size to 20 articles so supplemental retrieval can run quickly.

---

## 7. Design Rationale

**Why collect DART filings through full pagination?**  
If we only fetch the latest 100 filings, documents can be missed during high-volume filing periods. Paginating the full `bgn_de` to `end_de` range with `PAGE_SIZE=100` ensures complete coverage within the target window.

**Why fetch the full news article separately through the HTML URL?**  
The Naver News API response includes only the title and summary. Event extraction and evidence recovery through `PassageIndex` require the full article body, so the HTML at `source_url` must be fetched separately.

**Why store correction filings as separate documents?**  
Both pre-correction and post-correction content must be preserved to trace factual changes over time. The documents are linked through `parent_rcept_no`, but each receives its own `raw_doc_id` so the version relationship remains explicit.
