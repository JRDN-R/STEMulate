from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from worker import (
    ClaimResult,
    RepositoryContractError,
    TaskPayload,
    expected_output_prefix,
)


class FirestoreJobRepository:
    """Atomic job validation and preview-state transitions."""

    def __init__(self, client: Any | None = None):
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            from google.cloud import firestore

            project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT")
            self._client = firestore.Client(project=project or None)
        return self._client

    @staticmethod
    def _firestore() -> Any:
        from google.cloud import firestore

        return firestore

    def _internal(self, job_id: str) -> Any:
        return self.client.document(f"internalJobs/{job_id}")

    def _public(self, owner_uid: str, job_id: str) -> Any:
        return self.client.document(f"users/{owner_uid}/jobs/{job_id}")

    @staticmethod
    def _output_identity(output: Mapping[str, Any]) -> tuple[Any, ...]:
        content_type = output.get("contentType")
        return (
            output.get("key"),
            output.get("storagePath"),
            content_type.lower() if isinstance(content_type, str) else content_type,
            output.get("sizeBytes"),
        )

    def claim_job(
        self,
        payload: TaskPayload,
        *,
        task_name: str,
        lease_seconds: int,
    ) -> ClaimResult:
        firestore = self._firestore()
        internal_ref = self._internal(payload.job_id)
        public_ref = self._public(payload.owner_uid, payload.job_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def claim(current_transaction: Any) -> ClaimResult:
            internal_snapshot = internal_ref.get(transaction=current_transaction)
            public_snapshot = public_ref.get(transaction=current_transaction)
            if not internal_snapshot.exists or not public_snapshot.exists:
                raise RepositoryContractError(
                    "JOB_NOT_FOUND",
                    "The processing job does not exist.",
                )
            internal = internal_snapshot.to_dict() or {}
            public = public_snapshot.to_dict() or {}
            if internal.get("ownerUid") != payload.owner_uid or public.get("ownerUid") != payload.owner_uid:
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The processing job owner is invalid.",
                )
            if internal.get("status") != "completed" or public.get("status") != "completed":
                raise RepositoryContractError(
                    "JOB_NOT_READY",
                    "The processing job is not ready for preview packaging.",
                )
            if (
                internal.get("previewAttempt") != payload.attempt
                or internal.get("previewManifestPath") != payload.manifest_path
                or public.get("previewManifestPath") != payload.manifest_path
            ):
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The preview task generation is no longer current.",
                )
            allowed_preview_states = {
                "queued",
                "retrying",
                "processing",
                "awaiting_finalize",
                "ready",
            }
            if (
                internal.get("previewStatus") not in allowed_preview_states
                or public.get("previewStatus") not in allowed_preview_states
            ):
                raise RepositoryContractError(
                    "JOB_NOT_READY",
                    "The preview task is no longer active.",
                )
            prefix = expected_output_prefix(payload.owner_uid, payload.job_id)
            public_outputs = public.get("outputs")
            if not isinstance(public_outputs, list) or any(
                not isinstance(item, dict)
                or not isinstance(item.get("storagePath"), str)
                or not item["storagePath"].startswith(prefix)
                for item in public_outputs
            ):
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The processing output record is invalid.",
                )
            authoritative = sorted(self._output_identity(item) for item in public_outputs)
            authoritative_by_identity = {
                (item[0], item[1]): item for item in authoritative
            }
            if len(authoritative_by_identity) != len(authoritative):
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The processing output record contains duplicate entries.",
                )
            supplied_identities = {(output.key, output.storage_path) for output in payload.outputs}
            if supplied_identities != set(authoritative_by_identity):
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The preview task outputs do not match the processing job.",
                )
            for output in payload.outputs:
                authoritative_output = authoritative_by_identity[(output.key, output.storage_path)]
                if (
                    output.content_type is not None
                    and output.content_type != authoritative_output[2]
                ) or (
                    output.size_bytes is not None
                    and output.size_bytes != authoritative_output[3]
                ):
                    raise RepositoryContractError(
                        "JOB_MISMATCH",
                        "The preview task output metadata does not match the processing job.",
                    )
            internal_outputs = internal.get("outputs")
            if not isinstance(internal_outputs, dict):
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The internal processing outputs are invalid.",
                )
            internal_identities = sorted(
                self._output_identity(item)
                for item in internal_outputs.values()
                if isinstance(item, dict)
            )
            if internal_identities != authoritative:
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The public and internal processing outputs do not match.",
                )
            internal_ready = internal.get("previewStatus") == "ready"
            public_ready = public.get("previewStatus") == "ready"
            if internal_ready or public_ready:
                if (
                    internal_ready
                    and public_ready
                    and public.get("previewManifestPath") == payload.manifest_path
                    and internal.get("previewManifestPath") == payload.manifest_path
                    and internal.get("previewAttempt") == payload.attempt
                ):
                    return ClaimResult("ready")
                raise RepositoryContractError(
                    "JOB_MISMATCH",
                    "The preview ready state is inconsistent.",
                )

            now = datetime.now(timezone.utc)
            lease_until = internal.get("previewLeaseUntil")
            if (
                internal.get("previewStatus") in {"processing", "awaiting_finalize"}
                and isinstance(lease_until, datetime)
                and lease_until > now
            ):
                return ClaimResult("busy")

            safe_lease_seconds = max(60, min(int(lease_seconds), 20 * 60))
            lease = now + timedelta(seconds=safe_lease_seconds)
            current_transaction.set(
                internal_ref,
                {
                    "previewStatus": "processing",
                    "previewManifestPath": payload.manifest_path,
                    "previewLeaseOwner": task_name,
                    "previewLeaseUntil": lease,
                    "previewError": None,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            current_transaction.set(
                public_ref,
                {
                    "previewStatus": "processing",
                    "previewError": None,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            return ClaimResult("claimed")

        return claim(transaction)

    @staticmethod
    def _safe_error(error: Mapping[str, str]) -> dict[str, str]:
        return {
            "code": str(error.get("code", "PREVIEW_FAILED"))[:80],
            "message": str(
                error.get("message", "The preview streams could not be prepared.")
            )[:300],
        }

    def _transition_if_owned(
        self,
        job_id: str,
        owner_uid: str,
        *,
        lease_owner: str,
        allowed_statuses: frozenset[str],
        internal_fields: Mapping[str, Any],
        public_fields: Mapping[str, Any],
    ) -> None:
        firestore = self._firestore()
        internal_ref = self._internal(job_id)
        public_ref = self._public(owner_uid, job_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def transition(current_transaction: Any) -> None:
            internal_snapshot = internal_ref.get(transaction=current_transaction)
            public_snapshot = public_ref.get(transaction=current_transaction)
            if not internal_snapshot.exists or not public_snapshot.exists:
                raise RepositoryContractError("JOB_NOT_FOUND", "The processing job does not exist.")
            internal = internal_snapshot.to_dict() or {}
            public = public_snapshot.to_dict() or {}
            if internal.get("ownerUid") != owner_uid or public.get("ownerUid") != owner_uid:
                raise RepositoryContractError("JOB_MISMATCH", "The processing job owner is invalid.")
            # Preview state can change; the original completed state and output
            # records are deliberately never overwritten by this service.
            if internal.get("status") != "completed" or public.get("status") != "completed":
                raise RepositoryContractError("JOB_NOT_READY", "The processing job is not complete.")
            if internal.get("previewStatus") == "ready" or public.get("previewStatus") == "ready":
                return
            if (
                internal.get("previewStatus") not in allowed_statuses
                or internal.get("previewLeaseOwner") != lease_owner
            ):
                raise RepositoryContractError(
                    "PREVIEW_LEASE_LOST",
                    "The preview task no longer owns this job lease.",
                )
            current_transaction.set(internal_ref, dict(internal_fields), merge=True)
            current_transaction.set(public_ref, dict(public_fields), merge=True)

        transition(transaction)

    def mark_failed(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
        *,
        lease_owner: str,
    ) -> None:
        firestore = self._firestore()
        safe_error = self._safe_error(error)
        self._transition_if_owned(
            job_id,
            owner_uid,
            lease_owner=lease_owner,
            allowed_statuses=frozenset({"processing", "awaiting_finalize"}),
            internal_fields={
                "previewStatus": "failed",
                "previewError": safe_error,
                "previewLeaseOwner": firestore.DELETE_FIELD,
                "previewLeaseUntil": firestore.DELETE_FIELD,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            public_fields={
                "previewStatus": "failed",
                "previewError": safe_error,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )

    def mark_retryable(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
        *,
        lease_owner: str,
    ) -> None:
        firestore = self._firestore()
        safe_error = self._safe_error(error)
        self._transition_if_owned(
            job_id,
            owner_uid,
            lease_owner=lease_owner,
            allowed_statuses=frozenset({"processing", "awaiting_finalize"}),
            internal_fields={
                "previewStatus": "retrying",
                "previewError": safe_error,
                "previewLeaseOwner": firestore.DELETE_FIELD,
                "previewLeaseUntil": firestore.DELETE_FIELD,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            public_fields={
                "previewStatus": "retrying",
                "previewError": safe_error,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )

    def mark_awaiting_finalize(
        self,
        job_id: str,
        owner_uid: str,
        manifest_path: str,
        *,
        lease_owner: str,
    ) -> None:
        firestore = self._firestore()
        self._transition_if_owned(
            job_id,
            owner_uid,
            lease_owner=lease_owner,
            allowed_statuses=frozenset({"processing"}),
            internal_fields={
                "previewStatus": "awaiting_finalize",
                "previewManifestPath": manifest_path,
                "previewLeaseUntil": datetime.now(timezone.utc) + timedelta(minutes=2),
                "previewError": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            public_fields={
                "previewStatus": "awaiting_finalize",
                "previewError": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )
