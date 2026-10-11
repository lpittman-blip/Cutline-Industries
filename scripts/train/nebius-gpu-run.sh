#!/usr/bin/env bash
# Take a bare Nebius GPU instance to a running Artemis training job.
#
# Trains ARTEMIS'S OWN WEIGHTS from random initialization — the Prime Core and
# its ten experts in gateway/artemis/model.py. No external model is downloaded,
# fine-tuned or distilled, and the corpus is human-written text, not generated
# output, per Blueprint Decisions 5 and 12.
#
#   SIZE=100m bash scripts/train/nebius-gpu-run.sh
#
# Environment:
#   SIZE         model size from gateway/configs/models.yaml   (default: 100m)
#   SHARDS       FineWeb parquet shards to download            (default: 20, ~2.4B tokens)
#   STEPS        training steps                                (default: 20000)
#   BATCH        sequences per GPU per micro-step              (default: 8)
#   ACCUM        gradient accumulation steps                   (default: 4)
#   WORK         working directory                             (default: /mnt/artemis)
set -euo pipefail

SIZE="${SIZE:-100m}"
SHARDS="${SHARDS:-20}"
STEPS="${STEPS:-20000}"
BATCH="${BATCH:-8}"
ACCUM="${ACCUM:-4}"
WORK="${WORK:-/mnt/artemis}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

echo "[1/5] GPUs"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader
NGPU=$(nvidia-smi --list-gpus | wc -l)
[ "$NGPU" -gt 0 ] || { echo "no GPU visible — wrong instance type"; exit 1; }

echo "[2/5] dependencies"
# torch with CUDA must match the driver; the default index gives the current build.
python3 -m pip install -q --upgrade pip
python3 -m pip install -q torch numpy pyyaml tokenizers huggingface_hub pyarrow

echo "[3/5] corpus — FineWeb (ODC-By-1.0, human web text)"
mkdir -p "$WORK/raw" "$WORK/data"
python3 - "$WORK/raw" "$SHARDS" <<'PY'
import sys
from pathlib import Path
from huggingface_hub import hf_hub_download
out, n = Path(sys.argv[1]), int(sys.argv[2])
# sample-10BT is the curated 10B-token slice: enough for the 100m rung without
# pulling the full multi-terabyte corpus.
for i in range(n):
    name = f"sample/10BT/{i:03d}_00000.parquet"
    try:
        p = hf_hub_download("HuggingFaceFW/fineweb", name, repo_type="dataset", local_dir=str(out))
        print("got", p)
    except Exception as e:
        print("stop at", name, e)
        break
PY

echo "[4/5] tokenizer + token shards"
cd "$REPO/gateway"
python3 - "$WORK" <<'PY'
import json, sys
from pathlib import Path
import pyarrow.parquet as pq
sys.path.insert(0, ".")
from artemis.tokenizer import train_tokenizer
from artemis.data import prepare

work = Path(sys.argv[1])
jsonl, flat = work / "corpus.jsonl", work / "corpus.txt"
rows = 0
with jsonl.open("w", encoding="utf-8") as j, flat.open("w", encoding="utf-8") as f:
    for parquet in sorted(work.glob("**/*.parquet")):
        for batch in pq.ParquetFile(parquet).iter_batches(batch_size=10_000, columns=["text"]):
            for text in batch.column("text").to_pylist():
                if not text:
                    continue
                j.write(json.dumps({"text": text}) + "\n")
                f.write(text.replace("\n", " ") + "\n")
                rows += 1
print("documents:", rows)

# The GPU sizes in configs/models.yaml all use vocab_size 32000.
train_tokenizer([str(flat)], vocab_size=32000, out_path=str(work / "tokenizer.json"))
m = prepare([{"path": str(jsonl), "license": "ODC-By-1.0",
              "origin": "HuggingFaceFW/fineweb sample-10BT, human web text"}],
            str(work / "tokenizer.json"), str(work / "data"), val_fraction=0.001)
print("train tokens:", m["train_tokens"], "val tokens:", m["val_tokens"])
PY

echo "[5/5] training — size $SIZE on $NGPU GPU(s)"
cd "$REPO/gateway"
COMMON=(--size "$SIZE" --data "$WORK/data" --out "$WORK/runs/$SIZE"
        --steps "$STEPS" --batch "$BATCH" --accum "$ACCUM"
        --eval-every 500 --eval-batches 50 --ckpt-every 1000)
if [ "$NGPU" -gt 1 ]; then
  torchrun --nproc_per_node "$NGPU" -m artemis.train "${COMMON[@]}"
else
  python3 -m artemis.train "${COMMON[@]}"
fi
