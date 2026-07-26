FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin stemulate \
    && mkdir -p /work \
    && chown 10001:10001 /work

WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --requirement requirements.txt \
    && python -m pip check \
    && python -c "import yt_dlp_plugins.extractor.getpot_bgutil_http" \
    && /usr/local/bin/yt-dlp --version \
    && /usr/local/bin/deno --version

COPY app.py firestore_repo.py worker.py ./

USER 10001:10001

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "1440", "--graceful-timeout", "15", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
