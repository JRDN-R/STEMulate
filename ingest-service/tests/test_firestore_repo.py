from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

from firestore_repo import FirestoreJobRepository


JOB = "0123456789abcdef0123456789abcdef"
OWNER = "owner_123"
INPUT = f"users/{OWNER}/jobs/{JOB}/input/source.m4a"


class FakeSnapshot:
    exists = True

    def __init__(self, value: dict[str, Any]):
        self.value = value

    def to_dict(self) -> dict[str, Any]:
        return self.value


class FakeDocument:
    def __init__(self, value: dict[str, Any], path: str):
        self.value = value
        self.path = path

    def get(self, transaction: Any = None) -> FakeSnapshot:
        del transaction
        return FakeSnapshot(self.value)


class FakeTransaction:
    def __init__(self) -> None:
        self.writes: list[Any] = []

    def set(self, *args: Any, **kwargs: Any) -> None:
        self.writes.append((args, kwargs))


class FakeClient:
    def __init__(self, value: dict[str, Any]):
        self.value = value
        self.current_transaction = FakeTransaction()

    def document(self, path: str) -> FakeDocument:
        return FakeDocument(self.value, path)

    def transaction(self) -> FakeTransaction:
        return self.current_transaction


class FakeFirestore:
    SERVER_TIMESTAMP = object()
    DELETE_FIELD = object()

    @staticmethod
    def Increment(value: int) -> tuple[str, int]:
        return ("increment", value)

    @staticmethod
    def transactional(function: Any) -> Any:
        return function


class LeaseTests(unittest.TestCase):
    def test_same_named_duplicate_is_busy_while_lease_is_active(self) -> None:
        client = FakeClient(
            {
                "ownerUid": OWNER,
                "inputPath": INPUT,
                "sourceKind": "remote",
                "status": "awaiting_upload",
                "downloadStatus": "running",
                "downloadLeaseOwner": f"download-{JOB}",
                "downloadLeaseUntil": datetime.now(timezone.utc) + timedelta(minutes=10),
            }
        )
        repository = FirestoreJobRepository(client)
        with patch.object(repository, "_firestore", return_value=FakeFirestore):
            result = repository.claim_job(
                JOB,
                OWNER,
                INPUT,
                f"download-{JOB}",
                datetime.now(timezone.utc) + timedelta(minutes=21),
            )
        self.assertEqual(result.state, "busy")
        self.assertEqual(client.current_transaction.writes, [])

    def test_job_already_handed_to_analysis_is_terminal(self) -> None:
        for status in ("queued", "processing", "completed", "failed"):
            with self.subTest(status=status):
                client = FakeClient(
                    {
                        "ownerUid": OWNER,
                        "inputPath": INPUT,
                        "sourceKind": "remote",
                        "status": status,
                        "downloadStatus": "running",
                    }
                )
                repository = FirestoreJobRepository(client)
                with patch.object(repository, "_firestore", return_value=FakeFirestore):
                    result = repository.claim_job(
                        JOB,
                        OWNER,
                        INPUT,
                        f"download-{JOB}",
                        datetime.now(timezone.utc) + timedelta(minutes=24),
                    )
                self.assertEqual(result.state, "terminal")
                self.assertEqual(client.current_transaction.writes, [])


class TransitionTests(unittest.TestCase):
    @staticmethod
    def repository(status: str) -> tuple[FirestoreJobRepository, FakeClient]:
        client = FakeClient(
            {
                "ownerUid": OWNER,
                "inputPath": INPUT,
                "sourceKind": "remote",
                "status": status,
                "downloadStatus": "running",
            }
        )
        return FirestoreJobRepository(client), client

    def test_retry_and_failure_noop_after_storage_finalize_wins(self) -> None:
        for method_name in (
            "mark_retryable",
            "mark_failed",
            "mark_upload_outcome_unknown",
        ):
            for status in ("queued", "processing", "completed", "failed"):
                with self.subTest(method=method_name, status=status):
                    repository, client = self.repository(status)
                    with patch.object(repository, "_firestore", return_value=FakeFirestore):
                        getattr(repository, method_name)(
                            JOB,
                            OWNER,
                            {"code": "UPLOAD_TIMEOUT", "message": "safe"},
                        )
                    self.assertEqual(client.current_transaction.writes, [])

    def test_retry_transition_is_atomic_while_awaiting_upload(self) -> None:
        repository, client = self.repository("awaiting_upload")
        with patch.object(repository, "_firestore", return_value=FakeFirestore):
            repository.mark_retryable(
                JOB,
                OWNER,
                {"code": "SOURCE_UNAVAILABLE", "message": "safe"},
            )
        writes = client.current_transaction.writes
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0][0][0].path, f"internalJobs/{JOB}")
        self.assertEqual(writes[0][0][1]["downloadStatus"], "retrying")
        self.assertNotIn("status", writes[0][0][1])
        self.assertEqual(writes[1][0][0].path, f"users/{OWNER}/jobs/{JOB}")
        self.assertEqual(writes[1][0][1]["stage"], "download_retry")

    def test_failure_transition_is_atomic_while_awaiting_upload(self) -> None:
        repository, client = self.repository("awaiting_upload")
        with patch.object(repository, "_firestore", return_value=FakeFirestore):
            repository.mark_failed(
                JOB,
                OWNER,
                {"code": "INVALID_MEDIA", "message": "safe"},
            )
        writes = client.current_transaction.writes
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0][0][1]["status"], "failed")
        self.assertEqual(writes[1][0][1]["status"], "failed")

    def test_unknown_upload_keeps_internal_awaiting_for_finalize(self) -> None:
        repository, client = self.repository("awaiting_upload")
        with patch.object(repository, "_firestore", return_value=FakeFirestore):
            repository.mark_upload_outcome_unknown(
                JOB,
                OWNER,
                {"code": "UPLOAD_OUTCOME_UNKNOWN", "message": "safe"},
            )
        writes = client.current_transaction.writes
        self.assertEqual(len(writes), 2)
        internal_update = writes[0][0][1]
        self.assertNotIn("status", internal_update)
        self.assertEqual(internal_update["downloadStatus"], "awaiting_finalize")
        self.assertEqual(writes[1][0][1]["stage"], "uploading_source")


if __name__ == "__main__":
    unittest.main()
