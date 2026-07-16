# Download-strategy benchmark — results (2026-07, local single-node)

Ran `model_download_bench.py` against the Texera dev **MinIO on the same laptop** (8 GB, single SSD).
Methods: `sequential` (today), `parallel_fanout` (A2), `boto3_multipart` (A2-ranged/A3),
`s5cmd` (native Go tool). Cold = fresh dir; warm = dir kept → per-file skip (the A5 cache case).

## Results (concurrency 32)

**Big — 1 × 10 GiB** *(all four in one run → the only clean apples-to-apples comparison)*
| method | cold (s) | GiB/s |
|---|---|---|
| sequential | 225 | 0.04 |
| parallel_fanout | 213 | 0.05 |
| boto3_multipart | 167 | 0.06 |
| **s5cmd** | **108** | **0.09** ← fastest, ~2× sequential |

**Small — 800 × 256 KB (0.2 GiB)**
| method | cold (s) |
|---|---|
| sequential | 7.3 |
| **parallel_fanout** | **2.8** ← fastest |
| boto3_multipart | 4.6 |
| s5cmd | 8.9 (no advantage on tiny files) |

**LLM mix — 3 × 3 GiB shards + 500 small (9 GiB)**
| method | cold (s) |
|---|---|
| sequential | 59 |
| parallel_fanout | 62 |
| **boto3_multipart** | **240 ← 4× WORSE (footgun)** |
| s5cmd | 84 |

**Warm (cache hit):** Python methods → **~0.01 s (instant)** on every shape. (s5cmd's "warm" isn't a
cache result — the harness runs `s5cmd cp` which re-downloads; use `s5cmd sync` to skip existing.)

**Peak RAM:** 56–257 MB across everything (≈ concurrency × 8 MB chunk), i.e. **tiny vs the 10 GB
file** — streaming works; big models never blow memory.

## Honest caveats (read before trusting absolute numbers)
1. **Disk-bound single node.** MinIO *reads* and the destination *writes* on the **same SSD**, so
   throughput caps ~0.1 GiB/s. This **understates parallel/multipart for big files** — their real
   advantage shows only when the **network** is the bottleneck (remote/clustered MinIO). To measure
   that: rerun `big` against a remote or throttled MinIO.
2. **Cross-run variance is large.** Only the **big** table is a single run (comparable). Small/llm
   Python numbers and the s5cmd numbers came from **separate runs** under different disk pressure
   (the disk filled as tests ran: sequential-big was 137 s in the first run, 225 s later). Treat
   cross-shape/cross-tool absolutes as rough; trust the **within-run big** ordering.
3. **s5cmd runs carried a `MallocStackLogging` overhead** (an env artifact) that likely inflated its
   times, especially on the tiny-file run — so s5cmd's small-file result may be pessimistic.

## Findings that hold
- **Big single file:** `s5cmd` is fastest — a lean native downloader extracts more than the Python
  loops **even when nominally disk-bound** (Python per-chunk overhead was leaving throughput on the
  table).
- **Many small files:** cross-file **concurrency** wins (`parallel_fanout` 2.6× over sequential);
  it's latency-bound, not throughput-bound.
- **`boto3_multipart` is a footgun on many-file folders** (4× slower on the LLM mix): per-file
  transfer-manager overhead + thread oversubscription. Fine only for a single big file.
- **Warm cache dominates** — instant on repeat; the biggest real-world lever for reuse.
- **A2 vs A3 is not a speed decision** — perf-equivalent on the cases that matter; choose on
  auth/creds/coupling.

## Verdict for Texera
- **Speed + a binary in the CU image is acceptable → `s5cmd` (use `sync` for caching).** Fastest for
  big files; single Apache-2.0 binary.
- **Dependency-free Python path → `parallel_fanout` (A2)** + tune concurrency high for small-file
  folders. Best Python option; keeps today's auth model.
- **Avoid per-file `boto3_multipart` as a general default.**
- **Always layer the A5 cache** (shared, per-immutable-version) — it beats every download tweak for
  reuse.
- **Next measurement to make the big-file story real:** rerun against **remote/throttled MinIO** so
  the network (not the local disk) is the bottleneck.
