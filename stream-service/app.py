from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable

from flask import Flask, Response, jsonify, request

from firestore_repo import FirestoreJobRepository
from storage_repo import GcsObjectStorage
from worker import (
    BUCKET_RE,
    JOB_ID_RE,
    MAX_TASK_BYTES,
    MediaPipeline,
    PayloadError,
    PreviewWorker,
    SubprocessRunner,
    ToolPaths,
    WorkerResult,
    log_event,
    validate_task_payload,
)


QUEUE_RE = re.compile(r"^[a-z][a-z0-9-]{0,98}[a-z0-9]$")
TASK_NAME_RE = re.compile(r"^preview-([A-Za-z0-9_-]{1,128})-v1-([1-9][0-9]?)$")


def _required_environment(name: str, pattern: re.Pattern[str]) -> str:
    value = os.environ.get(name, "").strip()
    if not value or not pattern.fullmatch(value):
        raise RuntimeError(f"{name} is missing or invalid")
    return value


def _header_resource_name(value: str) -> str:
    return value.rsplit("/", 1)[-1]


def build_default_worker(storage_bucket: str) -> PreviewWorker:
    retry_count = int(os.environ.get("MAX_TASK_RETRY_COUNT", "9"))
    if retry_count < 0 or retry_count > 10:
        raise RuntimeError("MAX_TASK_RETRY_COUNT must be between 0 and 10")
    bitrate_kbps = int(os.environ.get("PREVIEW_BITRATE_KBPS", "160"))
    if bitrate_kbps < 64 or bitrate_kbps > 320:
        raise RuntimeError("PREVIEW_BITRATE_KBPS must be between 64 and 320")
    work_root = Path(os.environ.get("WORK_ROOT", "/work"))
    if not work_root.is_absolute():
        raise RuntimeError("WORK_ROOT must be absolute")
    work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not work_root.is_dir() or not os.access(work_root, os.W_OK | os.X_OK):
        raise RuntimeError("WORK_ROOT is not writable by the service identity")
    return PreviewWorker(
        FirestoreJobRepository(),
        GcsObjectStorage(storage_bucket),
        MediaPipeline(
            SubprocessRunner(),
            ToolPaths(),
            bitrate_kbps=bitrate_kbps,
        ),
        work_root=work_root,
        max_retry_count=retry_count,
    )


def create_app(
    worker_factory: Callable[[], PreviewWorker] | None = None,
    *,
    storage_bucket: str | None = None,
    expected_queue: str | None = None,
) -> Flask:
    application = Flask(__name__)
    application.config["MAX_CONTENT_LENGTH"] = MAX_TASK_BYTES
    configured_bucket = storage_bucket or _required_environment("STORAGE_BUCKET", BUCKET_RE)
    configured_queue = expected_queue or _required_environment("EXPECTED_TASK_QUEUE", QUEUE_RE)
    make_worker = worker_factory or (lambda: build_default_worker(configured_bucket))

    @application.after_request
    def no_store(response: Response) -> Response:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @application.get("/healthz")
    def health() -> tuple[dict[str, str], int]:
        return {"status": "ok"}, 200

    @application.post("/tasks/preview")
    def preview() -> Response | tuple[Response, int]:
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
        if (
            not match
            or not JOB_ID_RE.fullmatch(match.group(1))
            or match.group(1) != payload.job_id
            or int(match.group(2)) != payload.attempt
            or task_name != f"preview-{payload.job_id}-v1-{match.group(2)}"
        ):
            return jsonify({"error": "invalid task headers"}), 400

        try:
            result: WorkerResult = make_worker().process(
                payload,
                task_name=task_name,
                retry_count=int(retry_header),
            )
        except Exception as error:
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
