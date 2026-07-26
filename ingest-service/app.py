from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable

from flask import Flask, Response, jsonify, request

from firestore_repo import FirestoreJobRepository
from worker import (
    BUCKET_RE,
    IngestWorker,
    MediaPipeline,
    PayloadError,
    SignedUploader,
    SubprocessRunner,
    ToolPaths,
    WorkerResult,
    log_event,
    validate_task_payload,
)


QUEUE_RE = re.compile(r"^[a-z][a-z0-9-]{0,98}[a-z0-9]$")
TASK_NAME_RE = re.compile(r"^download-([A-Za-z0-9_-]{1,128})$")


def _required_environment(name: str, pattern: re.Pattern[str]) -> str:
    value = os.environ.get(name, "").strip()
    if not value or not pattern.fullmatch(value):
        raise RuntimeError(f"{name} is missing or invalid")
    return value


def _youtube_pot_provider_url() -> str:
    value = os.environ.get("YOUTUBE_POT_PROVIDER_URL", "").strip().rstrip("/")
    if not value:
        raise RuntimeError("YOUTUBE_POT_PROVIDER_URL is missing or invalid")
    # The provider is deliberately reachable only through the Cloud Run
    # instance's shared loopback network. Do not turn this into an arbitrary
    # environment-configured HTTP client.
    if value != "http://127.0.0.1:4416":
        raise RuntimeError(
            "YOUTUBE_POT_PROVIDER_URL must be http://127.0.0.1:4416"
        )
    return value


def build_default_worker() -> IngestWorker:
    # The queue is configured for two total attempts, so retry-count values are
    # 0 for the first dispatch and 1 for the final dispatch.
    retry_count = int(os.environ.get("MAX_TASK_RETRY_COUNT", "1"))
    if retry_count < 0 or retry_count > 10:
        raise RuntimeError("MAX_TASK_RETRY_COUNT must be between 0 and 10")
    work_root = Path(os.environ.get("WORK_ROOT", "/tmp/stemulate-work"))
    if not work_root.is_absolute():
        raise RuntimeError("WORK_ROOT must be absolute")
    work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not work_root.is_dir() or not os.access(work_root, os.W_OK | os.X_OK):
        raise RuntimeError("WORK_ROOT is not writable by the service identity")
    return IngestWorker(
        FirestoreJobRepository(),
        MediaPipeline(
            SubprocessRunner(),
            ToolPaths(),
            youtube_pot_provider_url=_youtube_pot_provider_url(),
        ),
        SignedUploader(),
        spotify_client_id=os.environ.get("SPOTIFY_CLIENT_ID") or None,
        spotify_client_secret=os.environ.get("SPOTIFY_CLIENT_SECRET") or None,
        max_retry_count=retry_count,
        work_root=work_root,
    )


def _header_resource_name(value: str) -> str:
    return value.rsplit("/", 1)[-1]


def create_app(
    worker_factory: Callable[[], IngestWorker] = build_default_worker,
    *,
    storage_bucket: str | None = None,
    expected_queue: str | None = None,
) -> Flask:
    application = Flask(__name__)
    application.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    configured_bucket = storage_bucket or _required_environment("STORAGE_BUCKET", BUCKET_RE)
    configured_queue = expected_queue or _required_environment("EXPECTED_TASK_QUEUE", QUEUE_RE)

    @application.after_request
    def no_store(response: Response) -> Response:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @application.get("/healthz")
    def health() -> tuple[dict[str, str], int]:
        return {"status": "ok"}, 200

    @application.post("/tasks/download")
    def download() -> Response | tuple[Response, int]:
        queue_header = request.headers.get("X-CloudTasks-QueueName", "")
        task_header = request.headers.get("X-CloudTasks-TaskName", "")
        if _header_resource_name(queue_header) != configured_queue:
            return jsonify({"error": "forbidden"}), 403

        retry_header = request.headers.get("X-CloudTasks-TaskRetryCount", "0")
        if not retry_header.isdigit() or int(retry_header) > 100:
            return jsonify({"error": "invalid task headers"}), 400

        try:
            payload = validate_task_payload(request.get_json(silent=True), configured_bucket)
        except (PayloadError, ValueError):
            return jsonify({"error": "invalid task"}), 400

        task_name = _header_resource_name(task_header)
        match = TASK_NAME_RE.fullmatch(task_name)
        if not match or match.group(1) != payload.job_id:
            return jsonify({"error": "invalid task headers"}), 400

        try:
            result: WorkerResult = worker_factory().process(
                payload,
                task_name=task_name,
                retry_count=int(retry_header),
            )
        except Exception as error:
            # IAM and task metadata were already validated. Do not log request data,
            # signed URLs, source URLs, tool output, or exception messages.
            log_event(
                "request_internal_error",
                job_id=payload.job_id,
                code=type(error).__name__,
                retryCount=int(retry_header),
            )
            return jsonify({"error": "temporarily unavailable"}), 503

        if result.retryable:
            return jsonify({"error": "retry scheduled", "code": result.code}), 503
        return Response(status=204)

    return application


app = create_app()
