from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Mapping

from worker import OutputArtifact, PreviewError


class GcsObjectStorage:
    """Google Cloud Storage adapter using the Cloud Run identity through ADC."""

    def __init__(self, bucket_name: str, client: Any | None = None):
        self.bucket_name = bucket_name
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            from google.cloud import storage

            project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT")
            self._client = storage.Client(project=project or None)
        return self._client

    @property
    def bucket(self) -> Any:
        return self.client.bucket(self.bucket_name)

    def object_exists(self, storage_path: str) -> bool:
        try:
            return bool(self.bucket.blob(storage_path).exists(timeout=30))
        except Exception as error:
            raise PreviewError(
                "STORAGE_UNAVAILABLE",
                "Private preview storage was temporarily unavailable.",
                retryable=True,
            ) from error

    def read_bytes(self, storage_path: str, *, maximum_bytes: int) -> bytes:
        blob = self.bucket.blob(storage_path)
        try:
            blob.reload(timeout=30)
        except Exception as error:
            raise PreviewError(
                "STORAGE_UNAVAILABLE",
                "The stored preview manifest could not be read.",
                retryable=True,
            ) from error
        size = int(blob.size or 0)
        if size <= 0 or size > maximum_bytes:
            raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
        try:
            data = blob.download_as_bytes(
                if_generation_match=int(blob.generation),
                timeout=60,
                checksum="auto",
            )
        except Exception as error:
            raise PreviewError(
                "STORAGE_UNAVAILABLE",
                "The stored preview manifest could not be read.",
                retryable=True,
            ) from error
        if len(data) != size or len(data) > maximum_bytes:
            raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
        return data

    def download_source(
        self,
        output: OutputArtifact,
        destination: Path,
        *,
        maximum_bytes: int,
    ) -> int:
        blob = self.bucket.blob(output.storage_path)
        try:
            blob.reload(timeout=30)
        except Exception as error:
            if type(error).__name__ in {"NotFound", "Forbidden", "Unauthorized"}:
                raise PreviewError(
                    "SOURCE_UNAVAILABLE",
                    "A stored Music.ai stem was unavailable.",
                    retryable=type(error).__name__ == "NotFound",
                ) from error
            raise PreviewError(
                "STORAGE_UNAVAILABLE",
                "Private stem storage was temporarily unavailable.",
                retryable=True,
            ) from error
        size = int(blob.size or 0)
        if size <= 0 or size > maximum_bytes:
            raise PreviewError("SOURCE_TOO_LARGE", "A source stem has an invalid size.")
        if output.size_bytes is not None and size != output.size_bytes:
            raise PreviewError("SOURCE_MISMATCH", "A stored Music.ai stem no longer matches its job.")
        try:
            blob.download_to_filename(
                str(destination),
                if_generation_match=int(blob.generation),
                timeout=10 * 60,
                checksum="auto",
            )
        except Exception as error:
            raise PreviewError(
                "STORAGE_UNAVAILABLE",
                "A source stem could not be downloaded.",
                retryable=True,
            ) from error
        if destination.stat().st_size != size:
            raise PreviewError("SOURCE_MISMATCH", "A stored Music.ai stem failed validation.")
        return size

    @staticmethod
    def _is_precondition_failed(error: Exception) -> bool:
        return type(error).__name__ == "PreconditionFailed"

    @staticmethod
    def _verify_existing(
        blob: Any,
        *,
        expected_size: int,
        expected_content_type: str,
        expected_sha256: str,
    ) -> None:
        blob.reload(timeout=30)
        metadata = blob.metadata or {}
        if (
            int(blob.size or 0) != expected_size
            or blob.content_type != expected_content_type
            or metadata.get("sha256") != expected_sha256
        ):
            raise PreviewError(
                "PREVIEW_CONFLICT",
                "An existing preview object did not match this job.",
            )

    def upload_file_if_absent(
        self,
        source: Path,
        storage_path: str,
        *,
        content_type: str,
        metadata: Mapping[str, str],
    ) -> None:
        size = source.stat().st_size
        expected_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        if metadata.get("sha256") != expected_hash:
            raise PreviewError("INVALID_PREVIEW", "A preview checksum was inconsistent.")
        blob = self.bucket.blob(storage_path)
        blob.metadata = dict(metadata)
        try:
            blob.upload_from_filename(
                str(source),
                content_type=content_type,
                if_generation_match=0,
                timeout=10 * 60,
                checksum="auto",
            )
        except Exception as error:
            if not self._is_precondition_failed(error):
                raise PreviewError(
                    "STORAGE_UNAVAILABLE",
                    "A preview stream could not be stored.",
                    retryable=True,
                ) from error
            self._verify_existing(
                blob,
                expected_size=size,
                expected_content_type=content_type,
                expected_sha256=expected_hash,
            )

    def upload_bytes_if_absent(
        self,
        data: bytes,
        storage_path: str,
        *,
        content_type: str,
        metadata: Mapping[str, str],
    ) -> None:
        expected_hash = hashlib.sha256(data).hexdigest()
        if metadata.get("sha256") != expected_hash:
            raise PreviewError("INVALID_MANIFEST", "The preview manifest checksum was inconsistent.")
        blob = self.bucket.blob(storage_path)
        blob.metadata = dict(metadata)
        try:
            blob.upload_from_string(
                data,
                content_type=content_type,
                if_generation_match=0,
                timeout=60,
                checksum="auto",
            )
        except Exception as error:
            if not self._is_precondition_failed(error):
                raise PreviewError(
                    "STORAGE_UNAVAILABLE",
                    "The preview manifest could not be stored.",
                    retryable=True,
                ) from error
            self._verify_existing(
                blob,
                expected_size=len(data),
                expected_content_type=content_type,
                expected_sha256=expected_hash,
            )
