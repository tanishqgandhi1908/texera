#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file. Apache-2.0.
"""
Benchmark strategies for materializing a model/dataset FOLDER from MinIO/S3 onto a
worker's local disk. Compares the download methods we're weighing for Texera:

  sequential       one file at a time, streamed to disk        (today's approach)
  parallel_fanout  N files concurrently, whole-file GET each    (A2: fan out across files)
  boto3_multipart  N files concurrently, each via boto3 multipart (A2+ranged / A3: across files AND
                   byte-ranges within each big file)
  s5cmd            shell out to `s5cmd cp` if installed          (A3/A4 tool, 256 workers)

Reports wall-clock, throughput (GB/s), and peak RSS (proves streaming stays low-mem).
Runs COLD (fresh dest) and WARM (dest kept -> per-file skip = the A5 cache case).

Deps:  pip install boto3 requests
Config via env (defaults = Texera dev MinIO):
  S3_ENDPOINT=http://localhost:9000  S3_KEY=texera_minio  S3_SECRET=password
  S3_REGION=us-west-2  BENCH_BUCKET=texera-bench

Generate test data, then benchmark:
  python model_download_bench.py gen  --shape big   --size-gb 10
  python model_download_bench.py gen  --shape small --count 4000 --kb 512
  python model_download_bench.py gen  --shape llm                       # 3x3GB shards + 500 small
  python model_download_bench.py bench --shape big --concurrency 32 --repeat 2
  python model_download_bench.py bench --shape llm --concurrency 16
"""
import argparse, os, resource, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
import requests
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

EP = os.getenv("S3_ENDPOINT", "http://localhost:9000")
KEY = os.getenv("S3_KEY", "texera_minio")
SECRET = os.getenv("S3_SECRET", "password")
REGION = os.getenv("S3_REGION", "us-west-2")
BUCKET = os.getenv("BENCH_BUCKET", "texera-bench")
DEST = Path(os.getenv("BENCH_DEST", "/tmp/bench-dl"))
CHUNK = 8 << 20  # 8 MiB streaming chunks


def s3():
    return boto3.client("s3", endpoint_url=EP, aws_access_key_id=KEY,
                        aws_secret_access_key=SECRET, region_name=REGION,
                        config=Config(s3={"addressing_style": "path"}))  # MinIO = path-style


def peak_rss_mb():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024  # macOS=bytes, linux=KB


# ---------------- data generation ----------------
def gen(shape, size_gb, count, kb):
    c = s3()
    try:
        c.create_bucket(Bucket=BUCKET)
    except Exception:
        pass
    prefix = f"{shape}/"
    # wipe existing
    for pg in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for o in pg.get("Contents", []):
            c.delete_object(Bucket=BUCKET, Key=o["Key"])
    block = os.urandom(CHUNK)  # incompressible so MinIO can't cheat

    def put(key, nbytes):
        cfg = TransferConfig(multipart_threshold=64 << 20, multipart_chunksize=16 << 20,
                             max_concurrency=8)
        tmp = Path("/tmp") / ("gen_" + key.replace("/", "_"))
        with open(tmp, "wb") as f:
            written = 0
            while written < nbytes:
                w = min(CHUNK, nbytes - written)
                f.write(block[:w]); written += w
        c.upload_file(str(tmp), BUCKET, key, Config=cfg)
        tmp.unlink()

    if shape == "big":
        put(f"{prefix}model.bin", int(size_gb * (1 << 30)))
    elif shape == "small":
        for i in range(count):
            put(f"{prefix}f{i:05d}.bin", kb << 10)
    elif shape == "llm":  # realistic: a few big shards + config/tokenizer small files
        for i in range(3):
            put(f"{prefix}model-{i:05d}-of-00003.safetensors", 3 * (1 << 30))
        for i in range(500):
            put(f"{prefix}aux/f{i:04d}.json", 8 << 10)
    else:
        sys.exit("shape must be big|small|llm")
    print(f"generated shape={shape} under s3://{BUCKET}/{prefix}")


def list_keys(c, prefix):
    keys = []
    for pg in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for o in pg.get("Contents", []):
            keys.append((o["Key"], o["Size"]))
    return keys


# ---------------- download methods ----------------
def _dest_for(key):
    p = DEST / key
    p.parent.mkdir(parents=True, exist_ok=True)
    return p

def _warm_skip(key, size, warm):
    p = DEST / key
    return warm and p.exists() and p.stat().st_size == size

def m_sequential(c, keys, conc, warm):
    for key, size in keys:
        if _warm_skip(key, size, warm):
            continue
        url = c.generate_presigned_url("get_object", {"Bucket": BUCKET, "Key": key}, ExpiresIn=3600)
        with requests.get(url, stream=True) as r:
            with open(_dest_for(key), "wb") as f:
                for ch in r.iter_content(CHUNK):
                    f.write(ch)

def m_parallel_fanout(c, keys, conc, warm):
    def one(item):
        key, size = item
        if _warm_skip(key, size, warm):
            return
        url = c.generate_presigned_url("get_object", {"Bucket": BUCKET, "Key": key}, ExpiresIn=3600)
        with requests.get(url, stream=True) as r:
            with open(_dest_for(key), "wb") as f:
                for ch in r.iter_content(CHUNK):
                    f.write(ch)
    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(one, keys))

def m_boto3_multipart(c, keys, conc, warm):
    # per-file multipart (byte-range parallel) + fan out across files too
    cfg = TransferConfig(multipart_threshold=64 << 20, multipart_chunksize=16 << 20,
                         max_concurrency=max(2, conc // 2), use_threads=True)
    def one(item):
        key, size = item
        if _warm_skip(key, size, warm):
            return
        c.download_file(BUCKET, key, str(_dest_for(key)), Config=cfg)
    with ThreadPoolExecutor(max_workers=max(1, conc // 4)) as ex:
        list(ex.map(one, keys))

def m_s5cmd(c, keys, conc, warm):
    if not shutil.which("s5cmd"):
        raise RuntimeError("s5cmd not installed")
    env = dict(os.environ, AWS_ACCESS_KEY_ID=KEY, AWS_SECRET_ACCESS_KEY=SECRET, AWS_REGION=REGION)
    prefix = keys[0][0].split("/")[0]
    subprocess.run(["s5cmd", "--endpoint-url", EP, "--numworkers", str(conc), "cp",
                    f"s3://{BUCKET}/{prefix}/*", str(DEST / prefix) + "/"], check=True, env=env)

METHODS = {"sequential": m_sequential, "parallel_fanout": m_parallel_fanout,
           "boto3_multipart": m_boto3_multipart, "s5cmd": m_s5cmd}


# ---------------- benchmark driver ----------------
def bench(shape, conc, repeat, methods):
    c = s3()
    keys = list_keys(c, f"{shape}/")
    if not keys:
        sys.exit(f"no data for shape={shape}; run `gen --shape {shape}` first")
    total = sum(sz for _, sz in keys)
    print(f"\nshape={shape}  files={len(keys)}  total={total/(1<<30):.2f} GiB  "
          f"concurrency={conc}\n" + "-" * 78)
    print(f"{'method':<18}{'run':<7}{'time_s':>9}{'GiB/s':>9}{'peak_MB':>10}")
    for name in methods:
        fn = METHODS[name]
        for run in range(repeat):
            warm = run > 0
            if not warm and DEST.exists():
                shutil.rmtree(DEST)
            DEST.mkdir(parents=True, exist_ok=True)
            t0 = time.time()
            try:
                fn(c, keys, conc, warm)
            except Exception as e:
                print(f"{name:<18}{'—':<7}  SKIP/ERR: {e}")
                break
            dt = time.time() - t0
            gbs = (total / (1 << 30)) / dt if dt else 0
            tag = "warm" if warm else "cold"
            print(f"{name:<18}{tag:<7}{dt:>9.2f}{gbs:>9.2f}{peak_rss_mb():>10.0f}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen"); g.add_argument("--shape", required=True)
    g.add_argument("--size-gb", type=float, default=10); g.add_argument("--count", type=int, default=4000)
    g.add_argument("--kb", type=int, default=512)
    b = sub.add_parser("bench"); b.add_argument("--shape", required=True)
    b.add_argument("--concurrency", type=int, default=32); b.add_argument("--repeat", type=int, default=2)
    b.add_argument("--methods", default="sequential,parallel_fanout,boto3_multipart,s5cmd")
    a = ap.parse_args()
    if a.cmd == "gen":
        gen(a.shape, a.size_gb, a.count, a.kb)
    else:
        bench(a.shape, a.concurrency, a.repeat, [m for m in a.methods.split(",") if m in METHODS])


if __name__ == "__main__":
    main()
