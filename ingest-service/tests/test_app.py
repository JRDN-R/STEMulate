from __future__ import annotations

import os
import tempfile
import unittest
from typing import Any
from unittest.mock import patch

os.environ.setdefault("STORAGE_BUCKET", "stem-ulate.firebasestorage.app")
os.environ.setdefault("EXPECTED_TASK_QUEUE", "stemulate-downloads")

from app import build_default_worker, create_app  # noqa: E402
from test_worker import BUCKET, JOB, payload_value  # noqa: E402
from worker import WorkerResult  # noqa: E402


class FakeWorker:
    def __init__(self, result: WorkerResult):
        self.result = result
        self.calls: list[dict[str, Any]] = []

    def process(self, payload: Any, *, task_name: str, retry_count: int) -> WorkerResult:
        self.calls.append(
            {"payload": payload, "task_name": task_name, "retry_count": retry_count}
        )
        return self.result


def task_headers(**updates: str) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "X-CloudTasks-QueueName": "stemulate-downloads",
        "X-CloudTasks-TaskName": f"download-{JOB}",
        "X-CloudTasks-TaskRetryCount": "0",
    }
    headers.update(updates)
    return headers


class AppTests(unittest.TestCase):
    def client(self, result: WorkerResult = WorkerResult("accepted")) -> tuple[Any, FakeWorker]:
        worker = FakeWorker(result)
        application = create_app(
            lambda: worker, storage_bucket=BUCKET, expected_queue="stemulate-downloads"
        )
        application.testing = True
        return application.test_client(), worker

    def test_health(self) -> None:
        client, _ = self.client()
        response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_default_worker_requires_and_accepts_writable_absolute_work_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(
                os.environ,
                {"WORK_ROOT": temporary, "MAX_TASK_RETRY_COUNT": "1"},
                clear=False,
            ):
                worker = build_default_worker()
                self.assertEqual(worker.work_root, __import__("pathlib").Path(temporary))
                self.assertEqual(worker.max_retry_count, 1)
        with patch.dict(os.environ, {"WORK_ROOT": "relative"}, clear=False):
            with self.assertRaises(RuntimeError):
                build_default_worker()

    def test_accepts_authenticated_task_shape(self) -> None:
        client, worker = self.client()
        response = client.post("/tasks/download", json=payload_value(), headers=task_headers())
        self.assertEqual(response.status_code, 204)
        self.assertEqual(worker.calls[0]["task_name"], f"download-{JOB}")

    def test_rejects_wrong_queue_or_task_name(self) -> None:
        client, worker = self.client()
        response = client.post(
            "/tasks/download",
            json=payload_value(),
            headers=task_headers(**{"X-CloudTasks-QueueName": "other-queue"}),
        )
        self.assertEqual(response.status_code, 403)
        response = client.post(
            "/tasks/download",
            json=payload_value(),
            headers=task_headers(**{"X-CloudTasks-TaskName": "download-other"}),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(worker.calls, [])

    def test_retryable_worker_result_returns_503(self) -> None:
        client, _ = self.client(WorkerResult("retry", "SOURCE_UNAVAILABLE", True))
        response = client.post("/tasks/download", json=payload_value(), headers=task_headers())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["code"], "SOURCE_UNAVAILABLE")

    def test_permanent_failure_is_acknowledged_after_state_is_recorded(self) -> None:
        client, _ = self.client(WorkerResult("failed", "INVALID_MEDIA"))
        response = client.post("/tasks/download", json=payload_value(), headers=task_headers())
        self.assertEqual(response.status_code, 204)


if __name__ == "__main__":
    unittest.main()
