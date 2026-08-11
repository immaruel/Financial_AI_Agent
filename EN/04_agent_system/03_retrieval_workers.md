# 03. Retrieval Workers: Graph / Hybrid / Document-block

## 1. Purpose

Only the workers selected in `RetrievalPolicy.channels` run, in parallel, to produce `EvidenceBlock` candidates. The three workers use different resources and algorithms, but all return results in the same `EvidenceBlock` unit, so fusion, reranking, and verification work the same way regardless of channel.

| Worker | Class | Target |
|---|---|---|
| Graph | `GraphRetrievalWorker` (`retrieval/graph.py`) | Knowledge-graph relationship paths → linked source evidence |
| Hybrid (lexical + vector) | `HybridRetrievalWorker` (`retrieval/hybrid.py`) | Paragraph/footnote-centered source-text search |
| Document-block | `HybridRetrievalWorker(document_blocks_only=True)` | Tables/table cells/figures/captions |

---

## 2. The Common Evidence Unit: EvidenceBlock

Every channel queries the same `EvidenceBlock` catalog, built by `EvidenceCatalog` (`retrieval/hybrid.py`) from `InMemoryGraphStore.passage_index`.

```json
{
  "evidence_id": "ev_456",
  "document_id": "doc_123",
  "block_id": "blk_17",
  "source_type": "filing",
  "source_url": "https://...",
  "published_at": "2026-05-10T20:00:00+09:00",
  "effective_at": "2026-03-31T00:00:00+09:00",
  "effective_period": "2026Q1",
  "block_type": "table_cell",
  "text": "...",
  "locator": {
    "page": 42,
    "section": "Revenue or Change in Earnings Structure",
    "table_id": "table_7",
    "row": "Revenue",
    "column": "Current period",
    "char_start": 1024,
    "char_end": 1320
  },
  "structured": {"grid": [...], "headers": [...]},
  "content_hash": "sha256:...",
  "citable": true,
  "synthetic": false,
  "derivation": "native_text",
  "human_reviewed": false,
  "retrieval_channels": ["lexical", "graph"],
  "retrieval_scores": {"rrf": 0.031, "reranker": 4.2}
}
```

`evidence_id` is deterministically derived as the sha256 of `document_id + block_id + sentence_id + content_hash`, so the same source fragment merges into a single ID even when found through different channels. `EvidenceCatalog.snapshot_id` hashes the whole catalog, so the same query can be reproduced against the same index snapshot.

### 2.1 Source Blocks and Artifact Preservation

The collectors (`collection/source_connector.py`, `collection/document_parser.py`) store DART ZIP/XML, publisher HTML, and PDF sources immutably in an `artifact_store`, and split the parsed output into `paragraph`/`heading`/`table`/`table_cell`/`figure`/`caption`/`image`/`footnote` blocks. Tables retain both human-readable text and a `headers`/`rows` structure; figures are linked to their page/DOM position, caption, and surrounding paragraph. If `EvidenceBlock.locator` is empty (no `page`/`xpath`/`table_id`/`char_start·end`) or `source_url` is missing, the evidence is not treated as a clickable citation — this condition is enforced both by the Evidence Requirement Gate in [04_evidence_and_claims.md](04_evidence_and_claims.md) and the locator check in [05_verification_and_answer_gate.md](05_verification_and_answer_gate.md).

Numbers read via OCR/vision (`derivation in {ocr, vision, mixed}`) are not accepted as numeric evidence unless `human_reviewed=True` — the system does not automatically trust a scanned document's numbers without the underlying table.

---

## 3. Graph Retrieval Worker

### 3.1 Input / Output

| Item | Description |
|---|---|
| Input | `QuerySpec`, `RetrievalPolicy`, `InMemoryGraphStore` |
| Output | `GraphWorkerOutput(result: WorkerResult, evidence: List[EvidenceBlock], paths: List[GraphPath], subgraph: SubGraphResult)` |

### 3.2 Processing Steps

```text
1. Seed discovery: use QuerySpec.entities' canonical_id directly if present in the graph;
   otherwise match canonical_name/surface against Company node aliases
2. If no seed is found, fail immediately (ENTITY_UNRESOLVED, non-retryable)
3. Hop count by intent: 3 hops if graph_mode == "primary", otherwise 2 hops
4. BFS subgraph traversal restricted to intent-specific allowed edge types
   (edges below min_edge_confidence are excluded)
5. Apply publication/business-period filters (published_at, effective_at/effective_period)
6. Build relationship paths starting from the seeds (up to 3 hops, up to 20 paths); each
   edge's confidence/inference_method/causal flag is preserved in path.edge_metadata
7. Expand the Event/EventCandidate/Document/DocumentBlock nodes along each path into
   EvidenceBlocks via connected passages in the PassageIndex
8. Attach only the evidence IDs actually reachable from a given path to that
   path's GraphPath.evidence_ids
```

### 3.3 Result States

| Condition | status | failure code |
|---|---|---|
| No seed | FAILED | `ENTITY_UNRESOLVED` (non-retryable) |
| Seed present but no path/nodes | FAILED | `RETRIEVAL_EMPTY` (retryable) |
| Paths exist but no citable evidence | PARTIAL | `INSUFFICIENT_PRIMARY_EVIDENCE` (retryable) |
| Both paths and evidence secured | SUCCESS | — |

### 3.4 Representing Causality

Each edge in `GraphPath.edge_metadata` carries `inference_method` (e.g., `heuristic_temporal_adjacency`) and `causal` (bool). An edge like `PRECEDES` that only expresses temporal order is marked `causal=False`, so claim generation and verification never mistake it for causation. Only a `CAUSED_BY` edge can carry `causal=True`.

---

## 4. Hybrid Retrieval Worker (Lexical + Vector)

### 4.1 Components

| Component | Class | Approach |
|---|---|---|
| Lexical | `LexicalRetriever` | Local BM25 (k1=1.5, b=0.75) with a Korean 2-gram-expanded tokenizer |
| Dense | `DenseRetriever` | `BAAI/bge-m3` adapter; on model load/inference failure it switches to an explicitly labeled `deterministic_hashing_fallback` (it never silently pretends to have succeeded) |
| Fusion | `_rrf()` / `fuse_ranked_evidence()` | Reciprocal Rank Fusion (`rrf_k` defaults to 60) |
| Rerank | `Reranker` | Cross-encoder (`BAAI/bge-reranker-v2-m3`) first, falling back to `deterministic_overlap_fallback` |

Calling with `document_blocks_only=True` restricts the target to `block_types = (table, table_cell, figure, caption, image)` and runs the same lexical/vector/RRF/rerank pipeline — only the worker name changes to `document_block_retrieval`; the algorithm is identical.

### 4.2 Execution Order

```text
1. EvidenceCatalog.select(): filter candidate corpus by as_of, source_filters,
   block_types, date_filter
2. If the corpus is empty, fail immediately (RETRIEVAL_EMPTY)
3. Run the lexical/vector channels in parallel (ThreadPoolExecutor)
4. When relative_sort == "published_desc", add a dedicated recency lane so a
   "latest" request is not truncated to older documents by relevance ties
5. Fuse per-channel RetrievalHits with RRF -> Reranker.rerank() -> cut to evidence_budget
6. Apply the planner's requested relative ordering (e.g. published_desc) as
   the final step with prioritize_relative_order()
```

### 4.3 Result States

| Condition | status | failure code |
|---|---|---|
| No corpus | FAILED | `RETRIEVAL_EMPTY` |
| Fusion produced nothing | FAILED | `RETRIEVAL_EMPTY` |
| A channel failed, or a model fallback was used | PARTIAL | `RETRIEVAL_DEGRADED` / `MODEL_FALLBACK` / `MODEL_UNAVAILABLE` |
| Normal | SUCCESS | — |

Even when a model is unavailable and the worker falls back to a deterministic method, the result is still returned — but `WorkerResult.failure` and `ToolCallTrace.backend` honestly record the backend actually used (e.g., `deterministic_hashing_fallback`).

---

## 5. Evidence Fusion and How the Two Retrieval Results Combine

Graph-worker candidates and hybrid-worker candidates are never merged at the node-ID/passage-rank level. Graph results are **first expanded into EvidenceBlocks**, and only then RRF-fused with lexical/vector results in the same evidence unit.

```text
graph seed → Event/Document → EvidenceBlock rank list
BM25 → EvidenceBlock rank list
vector → EvidenceBlock rank list
                           ↓
                fuse_ranked_evidence() (RRF, merges per-channel ranks)
                           ↓
                Reranker (cross-encoder, or a deterministic fallback)
                           ↓
             prioritize_relative_order() (final relative-time ordering)
```

`AgentOrchestrator._fuse_and_rerank()` owns this step and records a `ToolCallTrace` named `evidence_fusion_reranker` (including which backend was used and whether it was degraded).

---

## 6. Verification Points from a Harness Perspective

| Item | Meaning |
|------|---------|
| `seed_precision` / `seed_recall` | Did the QuerySpec entities lead to the correct starting node? |
| `subgraph_recall@k` | Were the key events/companies/documents needed for a correct answer included? |
| `evidence_recall@k` / `evidence_precision@k` | Did the channel retrieve the source text the answer needs? |
| `locator_valid_rate` | Can the returned evidence actually be navigated to a real page/paragraph/table position? |
| `channel_degradation_rate` | How often is a deterministic fallback used instead of a dedicated search model? |
| `fusion_backend distribution` | Was the reranker a cross-encoder or a fallback? |

Retrieval trace should record: seed node IDs, the seed-discovery method, hop count, allowed edge types, node/edge counts before and after pruning, the backend per channel, and `snapshot_id`.

Representative failure types: F1 entity confusion, F2 temporal error, and F5 missing evidence as an upstream cause.

---

## 7. Design Rationale

**Why not treat the graph as the final source of fact?**
The graph narrows down relationships and candidate documents quickly, but it does not guarantee the original sentence, table, or speaker position. A core financial claim must always pass citation, numeric, and temporal verification on an EvidenceBlock.

**Why run lexical and vector inside one worker (HybridRetrievalWorker)?**
The two channels share the same corpus, the same `evidence_budget`, and the same fusion rules. BM25 is strong for exact company names and numbers, while BGE-M3 is strong for semantically equivalent but differently worded text. Combining them into one worker keeps fallback, trace, and retry logic consistent across the two channels in one place.

**Why report a deterministic fallback "honestly" instead of hiding it?**
If BGE-M3/reranker fails to load and the worker silently returns lexical-only results, callers get a false impression that retrieval "worked well." Recording the `backend` field and a `MODEL_FALLBACK`/`MODEL_UNAVAILABLE` failure code makes later quality degradation traceable and reproducible.
