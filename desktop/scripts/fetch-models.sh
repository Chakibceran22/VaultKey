#!/usr/bin/env bash
# Search models for experiments, into src-tauri/models (gitignored), pinned by revision and
# SHA-256. The app ships without a model (docs/graph-search.md); these are only for the
# search crate's `meaning` feature (`cargo run -p vaultkey-search --features meaning --example eval`).
# Safe to re-run: files already present with the right hash are skipped, and an
# interrupted download resumes where it stopped (curl -C -).
#
#   bash scripts/fetch-models.sh         # arctic-embed-s + tokenizer (~35 MB)
#   bash scripts/fetch-models.sh all     # also bge-small and the reranker, for the eval (~57 MB)
#
# All are int8 (dynamic quantization) ONNX exports and share one tokenizer:
# bert-base-uncased WordPiece (vocabulary, normalizer and special tokens checked
# identical across the repositories).
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/models"
mkdir -p "$DEST"

ARCTIC="https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/e596f507467533e48a2e17c007f0e1dacc837b33"
BGE="https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3"
RERANK="https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/a09144355adeed5f58c8ed011d209bf8ee5a1fec"

fetch() { # url file sha256
  local url="$1" file="$DEST/$2" want="$3"
  if [[ -f "$file" ]] && [[ "$(shasum -a 256 "$file" | cut -d' ' -f1)" == "$want" ]]; then
    echo "ok       $2"
    return
  fi
  echo "fetching $2"
  curl -sS -L --fail --retry 5 --retry-delay 3 -C - -o "$file.part" "$url"
  local got
  got="$(shasum -a 256 "$file.part" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    rm -f "$file.part"
    echo "checksum mismatch for $2: got $got" >&2
    exit 1
  fi
  mv "$file.part" "$file"
}

# Snowflake arctic-embed-s (Apache-2.0): the best small one measured.
fetch "$BGE/tokenizer.json" tokenizer.json \
  d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66
fetch "$ARCTIC/onnx/model_quantized.onnx" snowflake-arctic-embed-s.onnx \
  f93ff225320628d2e88baf2a395cae791b0e3b27edf5c70bf7b312a4d3260c14

if [[ "${1:-}" == "all" ]]; then
  # BAAI bge-small-en-v1.5 (MIT) and cross-encoder ms-marco-MiniLM-L-6-v2 (Apache-2.0).
  fetch "$BGE/onnx/model_quantized.onnx" bge-small-en-v1.5.onnx \
    6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4
  fetch "$RERANK/onnx/model_quantized.onnx" ms-marco-MiniLM-L-6-v2.onnx \
    e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe
fi
