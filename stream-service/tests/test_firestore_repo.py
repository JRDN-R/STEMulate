from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from firestore_repo import FirestoreJobRepository
from test_adts import ATTEMPT, JOB, OWNER, payload_value
from worker import RepositoryContractError, expected_manifest_path, validate_task_payload


SERVER_TIMESTAMP = object()
DELETE_FIELD = object()


class FakeSnapshot:
    def __init__(self, data: dict | None):
        self.exists = data is not None
        self._data = data

    def to_dict(self) -> dict | None:
        return dict(self._data) if self._data is not None else None


class FakeDocument:
    def __init__(self, path: str, documents: dict[str, dict]):
        self.path = path
        self.documents = documents

    def get(self, transaction: object | None = None) -> FakeSnapshot:
        return FakeSnapshot(self.documents.get(self.path))


class FakeTransaction:
    def __init__(self, documents: dict[str, dict]):
        self.documents = documents
        self.writes: list[tuple[str, dict]] = []

    def set(self, reference: FakeDocument, values: dict, merge: bool = False) -> None:
        self.writes.append((reference.path, dict(values)))
        if merge:
            self.documents.setdefault(reference.path, {}).update(values)
        else:
            self.documents[reference.path] = dict(values)


class FakeClient:
    def __init__(self, documents: dict[str, dict]):
        self.documents = documents
        self.transactions: list[FakeTransaction] = []

    def document(self, path: str) -> FakeDocument:
        return FakeDocument(path, self.documents)

    def transaction(self) -> FakeTransaction:
        transaction = FakeTransaction(self.documents)
        self.transactions.append(transaction)
        return transaction


def fake_google_modules() -> dict[str, types.ModuleType]:
    firestore = types.ModuleType("google.cloud.firestore")
    firestore.SERVER_TIMESTAMP = SERVER_TIMESTAMP  # type: ignore[attr-defined]
    firestore.DELETE_FIELD = DELETE_FIELD  # type: ignore[attr-defined]

    def transactional(function):
        return function

    firestore.transactional = transactional  # type: ignore[attr-defined]
    cloud = types.ModuleType("google.cloud")
    cloud.firestore = firestore  # type: ignore[attr-defined]
    google = types.ModuleType("google")
    google.cloud = cloud  # type: ignore[attr-defined]
    return {
        "google": google,
        "google.cloud": cloud,
        "google.cloud.firestore": firestore,
    }


def job_documents() -> dict[str, dict]:
    output = payload_value()["outputs"][0]
    manifest_path = expected_manifest_path(OWNER, JOB, ATTEMPT)
    return {
        f"internalJobs/{JOB}": {
            "ownerUid": OWNER,
            "status": "completed",
            "outputs": {"vocals": dict(output)},
            "previewStatus": "queued",
            "previewAttempt": ATTEMPT,
            "previewManifestPath": manifest_path,
        },
        f"users/{OWNER}/jobs/{JOB}": {
            "ownerUid": OWNER,
            "status": "completed",
            "outputs": [dict(output)],
            "previewStatus": "queued",
            "previewManifestPath": manifest_path,
        },
    }


class FirestoreRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.modules = patch.dict(sys.modules, fake_google_modules())
        self.modules.start()

    def tearDown(self) -> None:
        self.modules.stop()

    def test_claim_checks_both_jobs_and_preserves_completed_state(self) -> None:
        documents = job_documents()
        client = FakeClient(documents)
        repository = FirestoreJobRepository(client)
        payload = validate_task_payload(payload_value(), payload_value()["storageBucket"])
        result = repository.claim_job(
            payload,
            task_name=f"preview-{JOB}",
            lease_seconds=840,
        )
        self.assertEqual(result.state, "claimed")
        internal = documents[f"internalJobs/{JOB}"]
        public = documents[f"users/{OWNER}/jobs/{JOB}"]
        self.assertEqual(internal["status"], "completed")
        self.assertEqual(public["status"], "completed")
        self.assertEqual(internal["previewStatus"], "processing")
        self.assertEqual(public["previewStatus"], "processing")
        self.assertEqual(
            internal["previewManifestPath"],
            expected_manifest_path(OWNER, JOB, ATTEMPT),
        )
        self.assertEqual(public["outputs"][0]["key"], "vocals")

    def test_ready_and_live_lease_are_idempotent(self) -> None:
        payload = validate_task_payload(payload_value(), payload_value()["storageBucket"])
        documents = job_documents()
        documents[f"internalJobs/{JOB}"].update(
            {
                "previewStatus": "ready",
                "previewManifestPath": payload.manifest_path,
            }
        )
        documents[f"users/{OWNER}/jobs/{JOB}"].update(
            {
                "previewStatus": "ready",
                "previewManifestPath": payload.manifest_path,
            }
        )
        repository = FirestoreJobRepository(FakeClient(documents))
        self.assertEqual(
            repository.claim_job(payload, task_name=f"preview-{JOB}", lease_seconds=840).state,
            "ready",
        )

        for status in ("processing", "awaiting_finalize"):
            documents = job_documents()
            documents[f"internalJobs/{JOB}"].update(
                {
                    "previewStatus": status,
                    "previewLeaseUntil": (
                        datetime.now(timezone.utc) + timedelta(minutes=5)
                    ),
                }
            )
            documents[f"users/{OWNER}/jobs/{JOB}"]["previewStatus"] = status
            repository = FirestoreJobRepository(FakeClient(documents))
            with self.subTest(status=status):
                self.assertEqual(
                    repository.claim_job(
                        payload,
                        task_name=f"preview-{JOB}",
                        lease_seconds=840,
                    ).state,
                    "busy",
                )

    def test_rejects_owner_status_and_authoritative_output_mismatches(self) -> None:
        payload = validate_task_payload(payload_value(), payload_value()["storageBucket"])
        mutations = [
            lambda docs: docs[f"internalJobs/{JOB}"].update(ownerUid="other"),
            lambda docs: docs[f"users/{OWNER}/jobs/{JOB}"].update(status="processing"),
            lambda docs: docs[f"users/{OWNER}/jobs/{JOB}"]["outputs"][0].update(sizeBytes=999),
            lambda docs: docs[f"internalJobs/{JOB}"]["outputs"].clear(),
            lambda docs: docs[f"internalJobs/{JOB}"].update(previewAttempt=ATTEMPT + 1),
        ]
        for mutate in mutations:
            documents = job_documents()
            mutate(documents)
            repository = FirestoreJobRepository(FakeClient(documents))
            with self.subTest(documents=documents):
                with self.assertRaises(RepositoryContractError):
                    repository.claim_job(
                        payload,
                        task_name=f"preview-{JOB}",
                        lease_seconds=840,
                    )

    def test_transitions_never_change_completed_or_regress_ready(self) -> None:
        documents = job_documents()
        lease_owner = f"preview-{JOB}:0:token"
        documents[f"internalJobs/{JOB}"].update(
            previewStatus="processing",
            previewLeaseOwner=lease_owner,
        )
        repository = FirestoreJobRepository(FakeClient(documents))
        repository.mark_failed(
            JOB,
            OWNER,
            {"code": "X" * 100, "message": "safe" * 100},
            lease_owner=lease_owner,
        )
        internal = documents[f"internalJobs/{JOB}"]
        public = documents[f"users/{OWNER}/jobs/{JOB}"]
        self.assertEqual(internal["status"], "completed")
        self.assertEqual(public["status"], "completed")
        self.assertEqual(public["previewStatus"], "failed")
        self.assertLessEqual(len(public["previewError"]["code"]), 80)
        self.assertLessEqual(len(public["previewError"]["message"]), 300)

        internal["previewStatus"] = "ready"
        public["previewStatus"] = "ready"
        repository.mark_awaiting_finalize(
            JOB,
            OWNER,
            expected_manifest_path(OWNER, JOB, ATTEMPT),
            lease_owner=lease_owner,
        )
        repository.mark_retryable(
            JOB,
            OWNER,
            {"code": "TEMP", "message": "Temporary."},
            lease_owner=lease_owner,
        )
        self.assertEqual(internal["previewStatus"], "ready")
        self.assertEqual(public["previewStatus"], "ready")

    def test_stale_worker_cannot_transition_a_replaced_lease(self) -> None:
        documents = job_documents()
        internal = documents[f"internalJobs/{JOB}"]
        internal.update(
            previewStatus="processing",
            previewLeaseOwner="current-lease",
        )
        repository = FirestoreJobRepository(FakeClient(documents))
        with self.assertRaises(RepositoryContractError):
            repository.mark_failed(
                JOB,
                OWNER,
                {"code": "STALE", "message": "Stale worker."},
                lease_owner="old-lease",
            )
        self.assertEqual(internal["previewStatus"], "processing")
        self.assertEqual(internal["previewLeaseOwner"], "current-lease")

    def test_awaiting_manifest_keeps_lease_and_can_record_upload_failure(self) -> None:
        documents = job_documents()
        internal = documents[f"internalJobs/{JOB}"]
        public = documents[f"users/{OWNER}/jobs/{JOB}"]
        lease_owner = f"preview-{JOB}:0:token"
        internal.update(
            previewStatus="processing",
            previewLeaseOwner=lease_owner,
            previewLeaseUntil=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        repository = FirestoreJobRepository(FakeClient(documents))
        repository.mark_awaiting_finalize(
            JOB,
            OWNER,
            expected_manifest_path(OWNER, JOB, ATTEMPT),
            lease_owner=lease_owner,
        )
        self.assertEqual(internal["previewStatus"], "awaiting_finalize")
        self.assertEqual(internal["previewLeaseOwner"], lease_owner)
        self.assertGreater(
            internal["previewLeaseUntil"],
            datetime.now(timezone.utc),
        )

        repository.mark_retryable(
            JOB,
            OWNER,
            {"code": "STORAGE_UNAVAILABLE", "message": "Temporary."},
            lease_owner=lease_owner,
        )
        self.assertEqual(internal["previewStatus"], "retrying")
        self.assertEqual(public["previewStatus"], "retrying")
        self.assertIs(internal["previewLeaseOwner"], DELETE_FIELD)
        self.assertIs(internal["previewLeaseUntil"], DELETE_FIELD)

    def test_expired_processing_generation_can_be_reclaimed(self) -> None:
        payload = validate_task_payload(payload_value(), payload_value()["storageBucket"])
        for status in ("processing", "awaiting_finalize"):
            documents = job_documents()
            internal = documents[f"internalJobs/{JOB}"]
            internal.update(
                previewStatus=status,
                previewLeaseOwner="crashed-worker",
                previewLeaseUntil=datetime.now(timezone.utc) - timedelta(seconds=1),
            )
            documents[f"users/{OWNER}/jobs/{JOB}"]["previewStatus"] = status
            repository = FirestoreJobRepository(FakeClient(documents))
            with self.subTest(status=status):
                result = repository.claim_job(
                    payload,
                    task_name="replacement-worker",
                    lease_seconds=840,
                )
                self.assertEqual(result.state, "claimed")
                self.assertEqual(internal["previewStatus"], "processing")
                self.assertEqual(
                    internal["previewLeaseOwner"],
                    "replacement-worker",
                )


if __name__ == "__main__":
    unittest.main()
