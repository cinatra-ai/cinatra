# syntax=docker/dockerfile:1
#
# cinatra local embedder — the vendor-free embedding floor (cinatra#2591).
# See server.py for WHY this exists; this file is only how it is packaged.
#
# fastembed runs sentence-transformers models through ONNX Runtime, so the image
# needs no torch (which would add ~2.5 GB). The model weights are pulled at BUILD
# time into the image's cache directory, so a container start needs no network
# and no Hugging Face reachability — a local floor that silently required an
# internet round trip on every cold start would not be a floor.

FROM python:3.12-slim-bookworm

ARG KG_EMBEDDER_MODEL=BAAI/bge-small-en-v1.5

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# FASTEMBED_CACHE_PATH is set explicitly because that is what lets the build
# bake the weights into a layer instead of downloading them at container start.
# (A comment cannot sit inside a line continuation, so it lives here.)
ENV PYTHONUNBUFFERED=1 \
    KG_EMBEDDER_MODEL=${KG_EMBEDDER_MODEL} \
    KG_EMBEDDER_PORT=8080 \
    FASTEMBED_CACHE_PATH=/opt/kg-embedder/models \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /app

RUN pip install --no-cache-dir "fastembed==0.8.0"

COPY server.py /app/server.py

# Bake the weights. This also fails the BUILD (not the first request) if the
# model name is wrong or the download is incomplete.
RUN python -c "from fastembed import TextEmbedding; import os; m = TextEmbedding(model_name=os.environ['KG_EMBEDDER_MODEL']); print('dimensions', len(next(iter(m.embed(['bake probe'])))))"

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["python", "/app/server.py"]
