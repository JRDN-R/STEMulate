from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from typing import Any

from storage_repo import GcsObjectStorage
from worker import OutputArtifact, PreviewError


class PreconditionFailed(Exception):
    pass


class FakeBlob:
    def __init__(self, name: str, data: bytes = b"", content_type: str = "audio/wav"):
        self.name = name
        self.data = data
        self.size = len(data)
        self.content_type = content_type
        self.metadata: dict[str, str] = {}
        self.server_metadata: dict[str, str] = {}
        self.generation = 7
        self.exists_value = bool(data)
        self.raise_exists: Exception | None = None
        self.raise_upload: Exception | None = None

    def exists(self, **kwargs: Any) -> bool:
        if self.raise_exists:
            raise self.raise_exists
        return self.exists_value

    def reload(self, **kwargs: Any) -> None:
        self.metadata = dict(self.server_metadata)

    def download_as_bytes(self, **kwargs: Any) -> bytes:
        return self.data

    def download_to_filename(self, filename: str, **kwargs: Any) -> None:
        Path(filename).write_bytes(self.data)

    def upload_from_filename(self, filename: str, **kwargs: Any) -> None:
        if self.raise_upload:
            raise self.raise_upload
        self.data = Path(filename).read_bytes()
        self.size = len(self.data)
        self.content_type = kwargs["content_type"]
        self.server_metadata = dict(self.metadata)
        self.exists_value = True

    def upload_from_string(self, data: bytes, **kwargs: Any) -> None:
        if self.raise_upload:
            raise self.raise_upload
        self.data = data
        self.size = len(data)
        self.content_type = kwargs["content_type"]
        self.server_metadata = dict(self.metadata)
        self.exists_value = True


class FakeBucket:
    def __init__(self):
        self.blobs: dict[str, FakeBlob] = {}

    def blob(self, name: str) -> FakeBlob:
        return self.blobs.setdefault(name, FakeBlob(name))


class FakeClient:
    def __init__(self, bucket: FakeBucket):
        self._bucket = bucket

    def bucket(self, name: str) -> FakeBucket:
        return self._bucket


class StorageTests(unittest.TestCase):
    def storage(self) -> tuple[GcsObjectStorage, FakeBucket]:
        bucket = FakeBucket()
        return GcsObjectStorage("bucket.example", FakeClient(bucket)), bucket

    def test_download_validates_generation_size_and_declared_size(self) -> None:
        storage, bucket = self.storage()
        path = "users/u/jobs/j/outputs/vocals.wav"
        bucket.blobs[path] = FakeBlob(path, b"abcdef")
        output = OutputArtifact("vocals", path, "audio/wav", 6)
        with tempfile.TemporaryDirectory() as raw:
            destination = Path(raw) / "source"
            size = storage.download_source(output, destination, maximum_bytes=100)
            self.assertEqual(size, 6)
            self.assertEqual(destination.read_bytes(), b"abcdef")
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaises(PreviewError) as caught:
                storage.download_source(
                    OutputArtifact("vocals", path, "audio/wav", 5),
                    Path(raw) / "source",
                    maximum_bytes=100,
                )
        self.assertEqual(caught.exception.code, "SOURCE_MISMATCH")

    def test_create_only_upload_is_idempotent_only_for_identical_object(self) -> None:
        storage, bucket = self.storage()
        path = "users/u/jobs/j/streams/v1/attempt-1/vocals.aac"
        data = b"preview"
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as raw:
            source = Path(raw) / "preview.aac"
            source.write_bytes(data)
            storage.upload_file_if_absent(
                source,
                path,
                content_type="audio/aac",
                metadata={"sha256": digest},
            )
            self.assertEqual(bucket.blobs[path].data, data)

            bucket.blobs[path].raise_upload = PreconditionFailed()
            storage.upload_file_if_absent(
                source,
                path,
                content_type="audio/aac",
                metadata={"sha256": digest},
            )
            bucket.blobs[path].server_metadata["sha256"] = "wrong"
            with self.assertRaises(PreviewError) as caught:
                storage.upload_file_if_absent(
                    source,
                    path,
                    content_type="audio/aac",
                    metadata={"sha256": digest},
                )
            self.assertEqual(caught.exception.code, "PREVIEW_CONFLICT")

    def test_manifest_read_is_bounded_and_storage_errors_are_safe(self) -> None:
        storage, bucket = self.storage()
        path = "users/u/jobs/j/streams/v1/attempt-1/manifest.json"
        bucket.blobs[path] = FakeBlob(path, b"{}")
        self.assertEqual(storage.read_bytes(path, maximum_bytes=10), b"{}")
        with self.assertRaises(PreviewError):
            storage.read_bytes(path, maximum_bytes=1)
        bucket.blobs[path].raise_exists = RuntimeError("secret details")
        with self.assertRaises(PreviewError) as caught:
            storage.object_exists(path)
        self.assertEqual(caught.exception.code, "STORAGE_UNAVAILABLE")
        self.assertNotIn("secret", caught.exception.public_message)


if __name__ == "__main__":
    unittest.main()
