# Model/dataset download benchmark

Compares the **download** strategies we're considering for materializing a model folder from
MinIO onto a worker's disk. Run this **on the VM** (needs the MinIO from the Texera stack + real
disk for 10 GB tests).

## The methods it measures
| Method | = which option | What it does |
|---|---|---|
| `sequential` | today | one file at a time, streamed |
| `parallel_fanout` | **A2** | N files at once, presigned URL + whole-file GET each |
| `boto3_multipart` | **A2-ranged / A3** | N files at once, each split into parallel byte-ranges (multipart) |
| `s5cmd` | A3/A4 tool | `s5cmd cp` (256 workers) — only if `s5cmd` is installed |

Also runs each **cold** (fresh dir) and **warm** (dir kept → per-file skip = the **A5 cache** case).

## Setup (on the VM, with the Texera stack running)
```bash
pip install boto3 requests
# optional, for the s5cmd method: install s5cmd from its releases
# defaults already match Texera dev MinIO; override if needed:
# export S3_ENDPOINT=http://localhost:9000 S3_KEY=texera_minio S3_SECRET=password
```

## Run
```bash
# 1) generate test data in MinIO (bucket 'texera-bench')
python model_download_bench.py gen --shape big   --size-gb 10          # one 10 GB file
python model_download_bench.py gen --shape small --count 4000 --kb 512 # 4000 small files
python model_download_bench.py gen --shape llm                         # 3x3GB shards + 500 small (LLM-like)

# 2) benchmark (cold + warm), try a few concurrency levels
python model_download_bench.py bench --shape big --concurrency 32
python model_download_bench.py bench --shape small --concurrency 64
python model_download_bench.py bench --shape llm  --concurrency 16
```

## What to compare (fill this in from the output)
| Method | big 10 GB (cold GiB/s) | small 4k (cold s) | llm (cold s) | warm | peak MB |
|---|---|---|---|---|---|
| sequential | | | | | |
| parallel_fanout | | | | | |
| boto3_multipart | | | | | |
| s5cmd | | | | | |

Expected shape of the result:
- **big single file:** `parallel_fanout` ≈ `sequential` (one URL, no intra-file parallelism);
  `boto3_multipart` / `s5cmd` win (byte-range parallel).
- **many small files:** `parallel_fanout` / `boto3_multipart` / `s5cmd` all crush `sequential`
  (cross-file concurrency); differences are about connection overhead.
- **warm:** all near-instant (cache skip) — this is the A5 win.
- **peak MB:** should stay low for all (streaming to disk), confirming big models don't blow RAM.
