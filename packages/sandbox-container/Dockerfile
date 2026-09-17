FROM docker.io/cloudflare/sandbox:0.12.9-python
RUN apt-get update && apt-get install -y --no-install-recommends nodejs ffmpeg jq \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir pandas openpyxl pypdf Pillow
