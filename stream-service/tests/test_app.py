from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

os.environ.setdefault("STORAGE_BUCKET", "stem-ulate.firebasestorage.app")
os.environ.setdefault("EXPECTED_TASK_QUEUE", "stemulate-previews")

from app import build_default_worker, create_app  # noqa: E402
from test_adts import BUCKET, JOB, payload_value  # noqa: E402
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


def headers(**updates: str) -> dict[str, str]:
    values = {
        "Content-Type": "application/json",
        "X-CloudTasks-QueueName": "stemulate-previews",
        "X-CloudTasks-TaskName": f"preview-{JOB}-v1-1",
        "X-CloudTasks-TaskRetryCount": "0",
    }
    values.update(updates)
    return values


class AppTests(unittest.TestCase):
    def client(self, result: WorkerResult = WorkerResult("accepted")) -> tuple[Any, FakeWorker]:
        worker = FakeWorker(result)
        application = create_app(
            lambda: worker,  # type: ignore[arg-type]
            storage_bucket=BUCKET,
            expected_queue="stemulate-previews",
        )
        application.testing = True
        return application.test_client(), worker

    def test_health_and_security_headers(self) -> None:
        client, _ = self.client()
        response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_accepts_only_matching_private_task_contract(self) -> None:
        client, worker = self.client()
        response = client.post("/tasks/preview", json=payload_value(), headers=headers())
        self.assertEqual(response.status_code, 204)
        self.assertEqual(worker.calls[0]["task_name"], f"preview-{JOB}-v1-1")

        response = client.post(
            "/tasks/preview",
            json=payload_value(),
            headers=headers(**{"X-CloudTasks-QueueName": "wrong"}),
        )
        self.assertEqual(response.status_code, 403)
        response = client.post(
            "/tasks/preview",
            json=payload_value(),
            headers=headers(**{"X-CloudTasks-TaskName": "preview-deadbeef-v1-1"}),
        )
        self.assertEqual(response.status_code, 400)

        uploaded_job = "AbC0123456789xyzWXYZ"
        value = payload_value()
        value["jobId"] = uploaded_job
        value["attempt"] = 2
        value["outputs"][0]["storagePath"] = (
            f"users/{value['ownerUid']}/jobs/{uploaded_job}/outputs/vocals.wav"
        )
        value["manifestPath"] = (
            f"users/{value['ownerUid']}/jobs/{uploaded_job}/"
            "streams/v1/attempt-2/manifest.json"
        )
        response = client.post(
            "/tasks/preview",
            json=value,
            headers=headers(
                **{"X-CloudTasks-TaskName": f"preview-{uploaded_job}-v1-2"}
            ),
        )
        self.assertEqual(response.status_code, 204)
        response = client.post(
            "/tasks/preview",
            json=value,
            headers=headers(
                **{"X-CloudTasks-TaskName": f"preview-{uploaded_job}-v1-1"}
            ),
        )
        self.assertEqual(response.status_code, 400)

    def test_retryable_response_is_503_and_terminal_is_acknowledged(self) -> None:
        client, _ = self.client(WorkerResult("retry", "STORAGE_UNAVAILABLE", True))
        response = client.post("/tasks/preview", json=payload_value(), headers=headers())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["code"], "STORAGE_UNAVAILABLE")
        client, _ = self.client(WorkerResult("failed", "INVALID_MEDIA"))
        response = client.post("/tasks/preview", json=payload_value(), headers=headers())
        self.assertEqual(response.status_code, 204)

    def test_invalid_payload_never_reaches_worker(self) -> None:
        client, worker = self.client()
        value = payload_value()
        value["manifestPath"] = "wrong"
        response = client.post("/tasks/preview", json=value, headers=headers())
        self.assertEqual(response.status_code, 400)
        self.assertEqual(worker.calls, [])

    def test_default_worker_validates_work_root_and_bitrate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with patch.dict(
                os.environ,
                {
                    "WORK_ROOT": raw,
                    "PREVIEW_BITRATE_KBPS": "160",
                    "MAX_TASK_RETRY_COUNT": "4",
                },
                clear=False,
            ):
                worker = build_default_worker(BUCKET)
                self.assertEqual(worker.work_root, Path(raw))
        with patch.dict(os.environ, {"WORK_ROOT": "relative"}, clear=False):
            with self.assertRaises(RuntimeError):
                build_default_worker(BUCKET)
        with patch.dict(
            os.environ,
            {"WORK_ROOT": "/tmp", "PREVIEW_BITRATE_KBPS": "500"},
            clear=False,
        ):
            with self.assertRaises(RuntimeError):
                build_default_worker(BUCKET)


if __name__ == "__main__":
    unittest.main()
