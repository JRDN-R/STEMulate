from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Mapping

from worker import ClaimResult, RepositoryContractError


class FirestoreJobRepository:
    """Minimal Firestore adapter; imports Google libraries lazily for testability."""

    def __init__(self, client: Any | None = None):
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            from google.cloud import firestore

            project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT")
            self._client = firestore.Client(project=project or None)
        return self._client

    def _internal(self, job_id: str) -> Any:
        return self.client.document(f"internalJobs/{job_id}")

    def _public(self, owner_uid: str, job_id: str) -> Any:
        return self.client.document(f"users/{owner_uid}/jobs/{job_id}")

    @staticmethod
    def _firestore() -> Any:
        from google.cloud import firestore

        return firestore

    def claim_job(
        self,
        job_id: str,
        owner_uid: str,
        input_path: str,
        task_name: str,
        lease_until: datetime,
    ) -> ClaimResult:
        firestore = self._firestore()
        reference = self._internal(job_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def claim(current_transaction: Any) -> ClaimResult:
            snapshot = reference.get(transaction=current_transaction)
            if not snapshot.exists:
                raise RepositoryContractError("JOB_NOT_FOUND", "The private import job does not exist.")
            job = snapshot.to_dict() or {}
            if job.get("ownerUid") != owner_uid or job.get("inputPath") != input_path:
                raise RepositoryContractError("JOB_MISMATCH", "The private import job is invalid.")
            if job.get("sourceKind") != "remote":
                raise RepositoryContractError("JOB_MISMATCH", "The private import job is invalid.")
            if job.get("downloadStatus") == "uploaded":
                return ClaimResult("uploaded", job)
            # Storage finalization changes this state to queued before Music.ai
            # work begins. A stale downloader task must never re-open that job.
            if job.get("status") != "awaiting_upload":
                return ClaimResult("terminal", job)

            existing_lease = job.get("downloadLeaseUntil")
            if (
                job.get("downloadStatus") == "running"
                and isinstance(existing_lease, datetime)
                and existing_lease > datetime.now(timezone.utc)
            ):
                return ClaimResult("busy", job)

            current_transaction.set(
                reference,
                {
                    "downloadStatus": "running",
                    "downloadLeaseOwner": task_name,
                    "downloadLeaseUntil": lease_until,
                    "downloadAttempt": firestore.Increment(1),
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            return ClaimResult("claimed", job)

        return claim(transaction)

    def publish_stage(
        self,
        job_id: str,
        owner_uid: str,
        stage: str,
        provider: str,
    ) -> None:
        firestore = self._firestore()
        batch = self.client.batch()
        batch.set(
            self._internal(job_id),
            {
                "downloadStatus": "running",
                "downloadStage": stage,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        batch.set(
            self._public(owner_uid, job_id),
            {
                "status": "processing",
                "stage": stage,
                "sourceProvider": provider,
                "error": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        batch.commit()

    @staticmethod
    def _safe_error(error: Mapping[str, str]) -> dict[str, str]:
        return {
            "code": str(error.get("code", "INGEST_FAILED"))[:80],
            "message": str(error.get("message", "The remote import failed."))[:300],
        }

    def _transition_while_awaiting_upload(
        self,
        job_id: str,
        owner_uid: str,
        internal_fields: Mapping[str, Any],
        public_fields: Mapping[str, Any],
    ) -> bool:
        """Atomically transition only while Storage finalization has not won."""
        firestore = self._firestore()
        internal_reference = self._internal(job_id)
        public_reference = self._public(owner_uid, job_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def transition(current_transaction: Any) -> bool:
            snapshot = internal_reference.get(transaction=current_transaction)
            if not snapshot.exists:
                return False
            job = snapshot.to_dict() or {}
            if job.get("ownerUid") != owner_uid or job.get("sourceKind") != "remote":
                raise RepositoryContractError("JOB_MISMATCH", "The private import job is invalid.")
            # The Storage finalize transaction changes status before queuing
            # Music.ai. Retried downloader writes must never overwrite it or
            # its public queued/processing/completed state.
            if job.get("status") != "awaiting_upload":
                return False
            current_transaction.set(
                internal_reference,
                dict(internal_fields),
                merge=True,
            )
            current_transaction.set(
                public_reference,
                dict(public_fields),
                merge=True,
            )
            return True

        return transition(transaction)

    def mark_retryable(self, job_id: str, owner_uid: str, error: Mapping[str, str]) -> None:
        firestore = self._firestore()
        safe_error = self._safe_error(error)
        self._transition_while_awaiting_upload(
            job_id,
            owner_uid,
            {
                "downloadStatus": "retrying",
                "downloadStage": "download_retry",
                "downloadLeaseOwner": firestore.DELETE_FIELD,
                "downloadLeaseUntil": firestore.DELETE_FIELD,
                "lastDownloadError": safe_error,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            {
                "status": "processing",
                "stage": "download_retry",
                "error": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )

    def mark_failed(self, job_id: str, owner_uid: str, error: Mapping[str, str]) -> None:
        firestore = self._firestore()
        safe_error = self._safe_error(error)
        self._transition_while_awaiting_upload(
            job_id,
            owner_uid,
            {
                "status": "failed",
                "downloadStatus": "failed",
                "downloadStage": "failed",
                "downloadLeaseOwner": firestore.DELETE_FIELD,
                "downloadLeaseUntil": firestore.DELETE_FIELD,
                "error": safe_error,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            {
                "status": "failed",
                "stage": "failed",
                "error": safe_error,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )

    def mark_upload_outcome_unknown(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
    ) -> None:
        firestore = self._firestore()
        safe_error = self._safe_error(error)
        self._transition_while_awaiting_upload(
            job_id,
            owner_uid,
            {
                # Deliberately do not change internal status. A valid Storage
                # finalize event must still be able to claim awaiting_upload.
                "downloadStatus": "awaiting_finalize",
                "downloadStage": "awaiting_storage_finalize",
                "downloadLeaseOwner": firestore.DELETE_FIELD,
                "downloadLeaseUntil": firestore.DELETE_FIELD,
                "lastDownloadError": safe_error,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            {
                "status": "processing",
                "stage": "uploading_source",
                "error": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )

    def mark_uploaded(self, job_id: str, owner_uid: str) -> None:
        del owner_uid  # Public state is owned by the Storage finalize trigger.
        firestore = self._firestore()
        self._internal(job_id).set(
            {
                "downloadStatus": "uploaded",
                "downloadStage": "uploaded",
                "downloadLeaseOwner": firestore.DELETE_FIELD,
                "downloadLeaseUntil": firestore.DELETE_FIELD,
                "downloadedAt": firestore.SERVER_TIMESTAMP,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
