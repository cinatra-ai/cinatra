# Execution-plane L0 base image (exec-plane S1, cinatra#1706 — epic #1705 D2).
#
# Successor of the openai-connector skill-shell runtime image: platform-owned,
# batteries included, and the ONLY image the sandbox worker runs commands over.
# Popular tools graduate into this image over releases (epic environment model,
# L0 tier). OS-level dependencies enter HERE, at build time, with root — a
# running sandbox has no root path at all (D2: the container runs as the fixed
# unprivileged runtime UID below, read-only rootfs, cap-drop ALL,
# no-new-privileges; enforced by the worker's hardened run profile, see
# packages/execution-plane/src/l0-profile.ts).
#
# Digest pinning: production resolves this image by digest
# (CINATRA_SANDBOX_L0_IMAGE holds a digest-pinned reference; deployment owns
# the pin). Local-dev builds the image from this file and tags it
# cinatra-sandbox-l0:dev; the worker records the RESOLVED digest of whatever
# ref it ran in every audit record, so the effective image is always attributable.
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    grep \
    jq \
    nodejs \
    npm \
    procps \
    ripgrep \
    sed \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Fixed, contractual runtime identity. The worker passes --user 10001:10001
# explicitly (defense in depth: the profile does not trust the image's USER),
# and the L2 workspace volume inherits this ownership from /workspace on first
# mount. Never reuse this UID for anything privileged.
RUN groupadd --gid 10001 sandbox \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash sandbox \
  && mkdir -p /workspace \
  && chown -R sandbox:sandbox /workspace /home/sandbox

WORKDIR /workspace

USER sandbox

CMD ["bash"]
