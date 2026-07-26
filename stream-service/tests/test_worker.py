from __future__ import annotations

import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from typing import Any

from test_adts import ATTEMPT, BUCKET, JOB, OWNER, adts_frame, payload_value
from worker import (
    MAX_SOURCE_BYTES,
    PACKET_FRAMES,
    ClaimResult,
    Deadline,
    MediaPipeline,
    OutputArtifact,
    PayloadError,
    PreviewError,
    PreviewWorker,
    ProbeResult,
    ProcessResult,
    TaskPayload,
    common_duration_frames,
    expected_manifest_path,
    expected_stream_path,
    select_stem_outputs,
    validate_manifest_bytes,
    validate_task_payload,
)


class FakeRepository:
    def __init__(self, claim_state: str = "claimed", timeline: list[str] | None = None):
        self.claim_state = claim_state
        self.timeline = timeline if timeline is not None else []
        self.failed: list[dict[str, str]] = []
        self.retried: list[dict[str, str]] = []
        self.awaiting: list[str] = []

    def claim_job(self, payload: TaskPayload, *, task_name: str, lease_seconds: int) -> ClaimResult:
        self.timeline.append("claim")
        return ClaimResult(self.claim_state)

    def mark_failed(
        self,
        job_id: str,
        owner_uid: str,
        error: dict[str, str],
        *,
        lease_owner: str,
    ) -> None:
        self.timeline.append("failed")
        self.failed.append(error)

    def mark_retryable(
        self,
        job_id: str,
        owner_uid: str,
        error: dict[str, str],
        *,
        lease_owner: str,
    ) -> None:
        self.timeline.append("retrying")
        self.retried.append(error)

    def mark_awaiting_finalize(
        self,
        job_id: str,
        owner_uid: str,
        manifest_path: str,
        *,
        lease_owner: str,
    ) -> None:
        self.timeline.append("awaiting_finalize")
        self.awaiting.append(manifest_path)


class FakeStorage:
    def __init__(
        self,
        *,
        timeline: list[str] | None = None,
        existing_manifest: bytes | None = None,
        manifest_failure: PreviewError | None = None,
    ):
        self.timeline = timeline if timeline is not None else []
        self.existing_manifest = existing_manifest
        self.manifest_failure = manifest_failure
        self.downloads: list[OutputArtifact] = []
        self.file_uploads: dict[str, bytes] = {}
        self.file_metadata: dict[str, dict[str, str]] = {}
        self.byte_uploads: dict[str, bytes] = {}
        self.byte_metadata: dict[str, dict[str, str]] = {}

    def object_exists(self, storage_path: str) -> bool:
        return self.existing_manifest is not None

    def read_bytes(self, storage_path: str, *, maximum_bytes: int) -> bytes:
        assert self.existing_manifest is not None
        return self.existing_manifest

    def download_source(
        self,
        output: OutputArtifact,
        destination: Path,
        *,
        maximum_bytes: int,
    ) -> int:
        self.downloads.append(output)
        destination.write_bytes(b"source")
        return len(b"source")

    def upload_file_if_absent(
        self,
        source: Path,
        storage_path: str,
        *,
        content_type: str,
        metadata: dict[str, str],
    ) -> None:
        self.timeline.append(f"stream:{storage_path.rsplit('/', 1)[-1]}")
        self.file_uploads[storage_path] = source.read_bytes()
        self.file_metadata[storage_path] = dict(metadata)

    def upload_bytes_if_absent(
        self,
        data: bytes,
        storage_path: str,
        *,
        content_type: str,
        metadata: dict[str, str],
    ) -> None:
        self.timeline.append("manifest")
        if self.manifest_failure:
            raise self.manifest_failure
        self.byte_uploads[storage_path] = data
        self.byte_metadata[storage_path] = dict(metadata)


class FakeMedia:
    def __init__(
        self,
        *,
        packet_counts: dict[str, int] | None = None,
        failure: PreviewError | None = None,
    ):
        self.packet_counts = packet_counts or {}
        self.failure = failure
        self.encode_calls: list[dict[str, Any]] = []

    def probe(self, source: Path, *, cwd: Path, deadline: Deadline) -> ProbeResult:
        if self.failure:
            raise self.failure
        return ProbeResult(Decimal("173.125"), 2)

    def encode(
        self,
        source: Path,
        destination: Path,
        *,
        duration_frames: int,
        channels: int,
        cwd: Path,
        deadline: Deadline,
    ) -> None:
        stem = destination.stem
        count = self.packet_counts.get(
            stem,
            duration_frames // PACKET_FRAMES + 1,
        )
        destination.write_bytes(adts_frame(channels=channels) * count)
        self.encode_calls.append(
            {
                "stem": stem,
                "duration_frames": duration_frames,
                "channels": channels,
            }
        )


def multi_payload_value() -> dict:
    value = payload_value()
    value["outputs"] = [
        {
            "key": "vocals",
            "storagePath": f"users/{OWNER}/jobs/{JOB}/outputs/vocals.wav",
            "contentType": "audio/wav",
            "sizeBytes": 6,
        },
        {
            "key": "drums",
            "storagePath": f"users/{OWNER}/jobs/{JOB}/outputs/drums.flac",
            "contentType": "audio/flac",
            "sizeBytes": 6,
        },
        {
            "key": "chordmap",
            "storagePath": f"users/{OWNER}/jobs/{JOB}/outputs/chordmap.json",
            "contentType": "application/json",
            "sizeBytes": 6,
        },
    ]
    return value


class PayloadTests(unittest.TestCase):
    def test_accepts_exact_task_and_optional_metadata(self) -> None:
        value = payload_value()
        del value["outputs"][0]["contentType"]
        del value["outputs"][0]["sizeBytes"]
        payload = validate_task_payload(value, BUCKET)
        self.assertEqual(payload.outputs[0].content_type, None)
        self.assertEqual(
            payload.manifest_path,
            expected_manifest_path(OWNER, JOB, ATTEMPT),
        )

    def test_rejects_wrong_bucket_manifest_traversal_duplicates_and_extras(self) -> None:
        cases = []
        wrong_bucket = payload_value()
        wrong_bucket["storageBucket"] = "other.example"
        cases.append(wrong_bucket)
        wrong_manifest = payload_value()
        wrong_manifest["manifestPath"] = f"users/{OWNER}/jobs/{JOB}/streams/v2/manifest.json"
        cases.append(wrong_manifest)
        wrong_attempt = payload_value()
        wrong_attempt["attempt"] = 0
        cases.append(wrong_attempt)
        stale_generation = payload_value()
        stale_generation["attempt"] = ATTEMPT + 1
        cases.append(stale_generation)
        traversal = payload_value()
        traversal["outputs"][0]["storagePath"] = (
            f"users/{OWNER}/jobs/{JOB}/outputs/../input/source.m4a"
        )
        cases.append(traversal)
        duplicate = payload_value()
        duplicate["outputs"].append(dict(duplicate["outputs"][0]))
        cases.append(duplicate)
        extra = payload_value()
        extra["debug"] = True
        cases.append(extra)
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(PayloadError):
                    validate_task_payload(value, BUCKET)

    def test_selects_only_canonical_audio_stems_and_first_collision_wins(self) -> None:
        payload = validate_task_payload(multi_payload_value(), BUCKET)
        selected = select_stem_outputs(payload.outputs)
        self.assertEqual(list(selected), ["vocals", "drums"])
        duplicate = list(payload.outputs)
        duplicate.append(
            OutputArtifact(
                "lead_vocals",
                f"users/{OWNER}/jobs/{JOB}/outputs/lead_vocals.wav",
                "audio/wav",
                6,
            )
        )
        collision_selection = select_stem_outputs(duplicate)
        self.assertEqual(collision_selection["vocals"].key, "vocals")

    def test_common_duration_rounds_up_to_aac_packet(self) -> None:
        frames = common_duration_frames(
            [ProbeResult(Decimal("1.001"), 1), ProbeResult(Decimal("1.1"), 2)]
        )
        self.assertEqual(frames % 1024, 0)
        self.assertGreaterEqual(frames, int(Decimal("1.1") * 48000))


class PipelineCommandTests(unittest.TestCase):
    def test_probe_and_encode_use_fixed_non_shell_contract(self) -> None:
        class Runner:
            def __init__(self):
                self.calls: list[list[str]] = []

            def run(
                self,
                argv: list[str],
                *,
                cwd: Path,
                timeout_seconds: float,
                capture_stdout: bool = False,
            ) -> ProcessResult:
                self.calls.append(argv)
                if "ffprobe" in argv[0]:
                    return ProcessResult(
                        0,
                        b'{"streams":[{"codec_type":"audio","channels":6}],'
                        b'"format":{"duration":"12.5"}}',
                    )
                Path(argv[-1]).write_bytes(adts_frame())
                return ProcessResult(0)

        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            source = work / "source.wav"
            source.write_bytes(b"x")
            destination = work / "preview.aac"
            runner = Runner()
            pipeline = MediaPipeline(runner)
            probe = pipeline.probe(source, cwd=work, deadline=Deadline(10))
            self.assertEqual(probe.channels, 2)
            pipeline.encode(
                source,
                destination,
                duration_frames=48 * 1024,
                channels=2,
                cwd=work,
                deadline=Deadline(10),
            )
            command = runner.calls[1]
            self.assertIn("aac_low", command)
            self.assertIn("adts", command)
            self.assertIn("aresample=48000", next(value for value in command if "aresample" in value))
            self.assertNotIn("http://", " ".join(command))


class WorkerTests(unittest.TestCase):
    def test_packages_aligned_streams_and_uploads_manifest_last(self) -> None:
        payload = validate_task_payload(multi_payload_value(), BUCKET)
        timeline: list[str] = []
        repository = FakeRepository(timeline=timeline)
        storage = FakeStorage(timeline=timeline)
        media = FakeMedia()
        with tempfile.TemporaryDirectory() as raw:
            worker = PreviewWorker(
                repository,
                storage,
                media,  # type: ignore[arg-type]
                work_root=Path(raw),
            )
            result = worker.process(payload, task_name=f"preview-{JOB}", retry_count=0)
        self.assertEqual(result.state, "accepted")
        self.assertEqual(len(storage.downloads), 2)
        self.assertEqual(
            timeline,
            [
                "claim",
                "stream:vocals.aac",
                "stream:drums.aac",
                "awaiting_finalize",
                "manifest",
            ],
        )
        manifest_bytes = storage.byte_uploads[payload.manifest_path]
        self.assertEqual(
            storage.byte_metadata[payload.manifest_path][
                "stemulate-preview-attempt"
            ],
            str(ATTEMPT),
        )
        manifest = validate_manifest_bytes(manifest_bytes, payload)
        self.assertEqual(set(manifest["stems"]), {"vocals", "drums"})
        self.assertEqual(
            manifest["durationFrames"],
            media.encode_calls[0]["duration_frames"],
        )
        for stem_id in ("vocals", "drums"):
            self.assertEqual(
                manifest["stems"][stem_id]["storagePath"],
                expected_stream_path(OWNER, JOB, ATTEMPT, stem_id),
            )
            self.assertEqual(
                storage.file_metadata[
                    expected_stream_path(OWNER, JOB, ATTEMPT, stem_id)
                ]["stemulate-preview-attempt"],
                str(ATTEMPT),
            )

    def test_existing_valid_manifest_is_idempotent(self) -> None:
        payload = validate_task_payload(payload_value(), BUCKET)
        packet = adts_frame()
        manifest = {
            "version": 1,
            "codec": "mp4a.40.2",
            "bitstream": "adts",
            "sampleRate": 48000,
            "packetFrames": 1024,
            "durationFrames": 1024,
            "stems": {
                "vocals": {
                    "storagePath": expected_stream_path(
                        OWNER,
                        JOB,
                        ATTEMPT,
                        "vocals",
                    ),
                    "channels": 2,
                    "sizeBytes": len(packet) * 2,
                    "windows": [
                        {
                            "startFrame": 0,
                            "frameCount": 1024,
                            "prerollByteStart": 0,
                            "byteStart": len(packet),
                            "byteEndExclusive": len(packet) * 2,
                        }
                    ],
                }
            },
        }
        storage = FakeStorage(existing_manifest=json.dumps(manifest).encode())
        repository = FakeRepository()
        with tempfile.TemporaryDirectory() as raw:
            worker = PreviewWorker(
                repository,
                storage,
                FakeMedia(),  # type: ignore[arg-type]
                work_root=Path(raw),
            )
            result = worker.process(payload, task_name=f"preview-{JOB}", retry_count=0)
        self.assertEqual(result.state, "accepted")
        self.assertEqual(storage.downloads, [])
        self.assertEqual(repository.awaiting, [payload.manifest_path])

    def test_retryable_failure_releases_state_for_retry(self) -> None:
        payload = validate_task_payload(payload_value(), BUCKET)
        repository = FakeRepository()
        media = FakeMedia(
            failure=PreviewError(
                "STORAGE_UNAVAILABLE",
                "Temporary.",
                retryable=True,
            )
        )
        with tempfile.TemporaryDirectory() as raw:
            worker = PreviewWorker(
                repository,
                FakeStorage(),
                media,  # type: ignore[arg-type]
                work_root=Path(raw),
            )
            result = worker.process(payload, task_name=f"preview-{JOB}", retry_count=0)
        self.assertTrue(result.retryable)
        self.assertEqual(repository.retried[0]["code"], "STORAGE_UNAVAILABLE")
        self.assertEqual(repository.failed, [])

    def test_manifest_upload_failure_leaves_awaiting_state_recoverable(self) -> None:
        payload = validate_task_payload(payload_value(), BUCKET)
        timeline: list[str] = []
        repository = FakeRepository(timeline=timeline)
        storage = FakeStorage(
            timeline=timeline,
            manifest_failure=PreviewError(
                "STORAGE_UNAVAILABLE",
                "Temporary.",
                retryable=True,
            ),
        )
        with tempfile.TemporaryDirectory() as raw:
            worker = PreviewWorker(
                repository,
                storage,
                FakeMedia(),  # type: ignore[arg-type]
                work_root=Path(raw),
            )
            result = worker.process(
                payload,
                task_name=f"preview-{JOB}",
                retry_count=0,
            )
        self.assertTrue(result.retryable)
        self.assertEqual(repository.retried[0]["code"], "STORAGE_UNAVAILABLE")
        self.assertEqual(
            timeline[-3:],
            ["awaiting_finalize", "manifest", "retrying"],
        )

    def test_final_retry_records_bounded_safe_failure(self) -> None:
        payload = validate_task_payload(payload_value(), BUCKET)
        repository = FakeRepository()
        media = FakeMedia(
            failure=PreviewError("ENCODE_FAILED", "x" * 1000, retryable=True)
        )
        with tempfile.TemporaryDirectory() as raw:
            worker = PreviewWorker(
                repository,
                FakeStorage(),
                media,  # type: ignore[arg-type]
                work_root=Path(raw),
                max_retry_count=0,
            )
            result = worker.process(payload, task_name=f"preview-{JOB}", retry_count=0)
        self.assertFalse(result.retryable)
        self.assertEqual(result.state, "failed")
        self.assertLessEqual(len(repository.failed[0]["message"]), 300)

    def test_mismatched_packet_counts_fail_without_manifest(self) -> None:
        payload = validate_task_payload(multi_payload_value(), BUCKET)
        repository = FakeRepository()
        storage = FakeStorage()
        with tempfile.TemporaryDirectory() as raw:
            worker = PreviewWorker(
                repository,
                storage,
                FakeMedia(packet_counts={"vocals": 10, "drums": 9}),  # type: ignore[arg-type]
                work_root=Path(raw),
            )
            result = worker.process(payload, task_name=f"preview-{JOB}", retry_count=0)
        self.assertEqual(result.code, "UNALIGNED_PREVIEW")
        self.assertNotIn(payload.manifest_path, storage.byte_uploads)
        self.assertEqual(repository.failed[0]["code"], "UNALIGNED_PREVIEW")

    def test_ready_and_busy_claims_do_no_media_work(self) -> None:
        payload = validate_task_payload(payload_value(), BUCKET)
        with tempfile.TemporaryDirectory() as raw:
            for state, expected in (("ready", "ready"), ("busy", "retry")):
                storage = FakeStorage()
                worker = PreviewWorker(
                    FakeRepository(state),
                    storage,
                    FakeMedia(),  # type: ignore[arg-type]
                    work_root=Path(raw),
                )
                result = worker.process(payload, task_name=f"preview-{JOB}", retry_count=0)
                self.assertEqual(result.state, expected)
                self.assertEqual(storage.downloads, [])


if __name__ == "__main__":
    unittest.main()
