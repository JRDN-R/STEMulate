from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence
from unittest.mock import Mock, patch
from urllib.parse import urlencode

import requests

from worker import (
    ClaimResult,
    IngestError,
    IngestWorker,
    MediaPipeline,
    PayloadError,
    ProcessResult,
    SignedUploader,
    Source,
    SubprocessRunner,
    TaskPayload,
    ToolPaths,
    WorkerResult,
    canonicalize_source_url,
    classify_youtube_failure,
    exactly_one_regular_file,
    isolated_child_environment,
    validate_task_payload,
)


BUCKET = "stem-ulate.firebasestorage.app"
OWNER = "owner_123"
JOB = "0123456789abcdef0123456789abcdef"
INPUT = f"users/{OWNER}/jobs/{JOB}/input/source.m4a"


def signed_url(*, path: str = INPUT, signed_headers: str | None = None) -> str:
    query = urlencode(
        {
            "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
            "X-Goog-Credential": "test@example.iam.gserviceaccount.com/20260722/auto/storage/goog4_request",
            "X-Goog-Date": "20260722T010203Z",
            "X-Goog-Expires": "86400",
            "X-Goog-SignedHeaders": signed_headers
            or "content-type;host;x-goog-meta-stemulate-job-id;x-goog-meta-stemulate-source",
            "X-Goog-Signature": "a" * 512,
            "ifGenerationMatch": "0",
        }
    )
    return f"https://storage.googleapis.com/{BUCKET}/{path}?{query}"


def payload_value(**updates: Any) -> dict[str, Any]:
    value = {
        "jobId": JOB,
        "ownerUid": OWNER,
        "storageBucket": BUCKET,
        "inputPath": INPUT,
        "uploadUrl": signed_url(),
    }
    value.update(updates)
    return value


class PayloadTests(unittest.TestCase):
    def test_accepts_exact_private_task_contract(self) -> None:
        payload = validate_task_payload(payload_value(), BUCKET)
        self.assertEqual(payload.job_id, JOB)
        self.assertEqual(payload.input_path, INPUT)

    def test_rejects_path_or_bucket_substitution(self) -> None:
        with self.assertRaises(PayloadError):
            validate_task_payload(payload_value(inputPath=f"users/{OWNER}/other.m4a"), BUCKET)
        with self.assertRaises(PayloadError):
            validate_task_payload(payload_value(storageBucket="attacker-bucket"), BUCKET)

    def test_owner_uid_contract_matches_functions_path_safety(self) -> None:
        for owner_uid in ("owner.name", "owner:name", "owner/name", "owner name"):
            input_path = f"users/{owner_uid}/jobs/{JOB}/input/source.m4a"
            with self.subTest(owner_uid=owner_uid), self.assertRaises(PayloadError):
                validate_task_payload(
                    payload_value(
                        ownerUid=owner_uid,
                        inputPath=input_path,
                        uploadUrl=signed_url(path=input_path),
                    ),
                    BUCKET,
                )
        for invalid_owner in ("owner/other", "owner\nother", ""):
            with self.subTest(owner=invalid_owner), self.assertRaises(PayloadError):
                validate_task_payload(payload_value(ownerUid=invalid_owner), BUCKET)

    def test_job_id_must_match_functions_lowercase_hex_contract(self) -> None:
        with self.assertRaises(PayloadError):
            validate_task_payload(payload_value(jobId="job_123"), BUCKET)

    def test_rejects_unsigned_required_headers_or_precondition(self) -> None:
        bad_headers = signed_url(signed_headers="content-type;host")
        with self.assertRaises(PayloadError):
            validate_task_payload(payload_value(uploadUrl=bad_headers), BUCKET)
        with self.assertRaises(PayloadError):
            validate_task_payload(
                payload_value(uploadUrl=signed_url().replace("ifGenerationMatch=0", "ifGenerationMatch=1")),
                BUCKET,
            )

    def test_accepts_24_hour_signature_but_rejects_longer_lifetime(self) -> None:
        validate_task_payload(payload_value(), BUCKET)
        too_long = signed_url().replace("X-Goog-Expires=86400", "X-Goog-Expires=86401")
        with self.assertRaises(PayloadError):
            validate_task_payload(payload_value(uploadUrl=too_long), BUCKET)

    def test_rejects_upload_host_and_object_changes(self) -> None:
        with self.assertRaises(PayloadError):
            validate_task_payload(
                payload_value(uploadUrl=signed_url().replace("storage.googleapis.com", "example.com")),
                BUCKET,
            )
        with self.assertRaises(PayloadError):
            validate_task_payload(payload_value(uploadUrl=signed_url(path="other/source.m4a")), BUCKET)


class SourceTests(unittest.TestCase):
    def test_accepts_only_canonical_single_tracks(self) -> None:
        youtube = canonicalize_source_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        spotify = canonicalize_source_url("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
        self.assertEqual(youtube, Source("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
        self.assertEqual(spotify.provider, "spotify")

    def test_rejects_playlists_shorteners_and_query_smuggling(self) -> None:
        rejected = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://open.spotify.com/album/1234567890123456789012",
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc",
            "https://user@example.com/track/4uLU6hMCjMI75M1A2tKUQC",
        ]
        for value in rejected:
            with self.subTest(value=value), self.assertRaises(IngestError):
                canonicalize_source_url(value)


class FileSafetyTests(unittest.TestCase):
    def test_requires_exactly_one_regular_nonsymlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "track.webm"
            media.write_bytes(b"audio")
            self.assertEqual(exactly_one_regular_file(root, 100), media)
            (root / "second.m4a").write_bytes(b"audio")
            with self.assertRaises(IngestError):
                exactly_one_regular_file(root, 100)

    def test_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_bytes(b"audio")
            (root / "alias").symlink_to(target)
            with self.assertRaises(IngestError):
                exactly_one_regular_file(root, 100)

    def test_child_environment_does_not_inherit_proxy_or_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(
                os.environ,
                {"HTTPS_PROXY": "http://proxy.invalid", "HOME": "/private/home"},
                clear=False,
            ):
                env = isolated_child_environment(Path(temporary))
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotEqual(env["HOME"], "/private/home")
            self.assertTrue(Path(env["HOME"]).is_dir())


class RecordingRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], Mapping[str, str]]] = []
        self.spotdl_config: dict[str, Any] | None = None
        self.spotdl_config_path: Path | None = None

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout_seconds: float,
        capture_stdout: bool = False,
        capture_stderr: bool = False,
    ) -> ProcessResult:
        del timeout_seconds, capture_stdout, capture_stderr
        self.calls.append((list(argv), dict(env)))
        if argv[0].endswith("yt-dlp"):
            destination = Path(argv[argv.index("--output") + 1].replace("%(ext)s", "webm"))
            destination.write_bytes(b"source")
        if argv[0].endswith("spotdl"):
            config_path = Path(env["HOME"]) / ".config" / "spotdl" / "config.json"
            self.spotdl_config_path = config_path
            self.spotdl_config = __import__("json").loads(config_path.read_text(encoding="utf-8"))
            destination = Path(argv[argv.index("--output") + 1].replace("{output-ext}", "m4a"))
            destination.write_bytes(b"source")
        return ProcessResult(0)


class MediaCommandTests(unittest.TestCase):
    def test_ytdlp_uses_fixed_hardened_argv_without_proxy_environment(self) -> None:
        from worker import Deadline

        runner = RecordingRunner()
        pipeline = MediaPipeline(runner, ToolPaths())
        with tempfile.TemporaryDirectory() as temporary:
            result = pipeline.download(
                Source("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
                Path(temporary),
                Deadline(10),
                None,
                None,
            )
        argv, env = runner.calls[0]
        self.assertEqual(argv[0], "/usr/local/bin/yt-dlp")
        for option in (
            "--ignore-config",
            "--no-remote-components",
            "--no-cookies",
            "--no-playlist",
            "--match-filters",
        ):
            self.assertIn(option, argv)
        self.assertNotIn("--max-downloads", argv)
        self.assertNotIn("--no-plugin-dirs", argv)
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertEqual(env["PYTHONNOUSERSITE"], "1")
        self.assertEqual(result.name, "source.webm")

    def test_ytdlp_uses_configured_pot_provider_and_mweb_fallback(self) -> None:
        from worker import Deadline

        runner = RecordingRunner()
        pipeline = MediaPipeline(
            runner,
            ToolPaths(),
            youtube_pot_provider_url="http://127.0.0.1:4416",
        )
        with tempfile.TemporaryDirectory() as temporary:
            pipeline.download(
                Source("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
                Path(temporary),
                Deadline(10),
                None,
                None,
            )
        argv, _ = runner.calls[0]
        extractor_args = [
            argv[index + 1]
            for index, value in enumerate(argv)
            if value == "--extractor-args"
        ]
        self.assertIn("youtube:player_client=default,mweb;fetch_pot=auto", extractor_args)
        self.assertIn(
            "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
            extractor_args,
        )
        self.assertEqual(
            argv[argv.index("--js-runtimes") + 1],
            "deno:/usr/local/bin/deno",
        )

    def test_ytdlp_failure_uses_bounded_stderr_classification(self) -> None:
        from worker import Deadline

        class FailingRunner:
            captured_stderr = False

            def run(
                self,
                argv: Sequence[str],
                *,
                cwd: Path,
                env: Mapping[str, str],
                timeout_seconds: float,
                capture_stdout: bool = False,
                capture_stderr: bool = False,
            ) -> ProcessResult:
                del argv, cwd, env, timeout_seconds, capture_stdout
                self.captured_stderr = capture_stderr
                return ProcessResult(
                    1,
                    stderr=b"ERROR: [youtube] Sign in to confirm you're not a bot",
                )

        runner = FailingRunner()
        pipeline = MediaPipeline(runner, ToolPaths())
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(IngestError) as raised:
            pipeline.download(
                Source("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
                Path(temporary),
                Deadline(10),
                None,
                None,
            )
        self.assertTrue(runner.captured_stderr)
        self.assertEqual(raised.exception.code, "YOUTUBE_ACCESS_BLOCKED")
        self.assertFalse(raised.exception.retryable)

    def test_spotify_requires_official_credentials(self) -> None:
        from worker import Deadline

        pipeline = MediaPipeline(RecordingRunner(), ToolPaths())
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(IngestError) as raised:
            pipeline.download(
                Source("spotify", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
                Path(temporary),
                Deadline(10),
                None,
                None,
            )
        self.assertEqual(raised.exception.code, "SPOTIFY_NOT_CONFIGURED")

    def test_spotdl_uses_boolean_config_flag_and_isolated_home_config(self) -> None:
        from worker import Deadline

        runner = RecordingRunner()
        pipeline = MediaPipeline(runner, ToolPaths())
        with tempfile.TemporaryDirectory() as temporary:
            result = pipeline.download(
                Source("spotify", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
                Path(temporary),
                Deadline(10),
                "official-client-id",
                "official-client-secret",
            )
        argv, env = runner.calls[0]
        config_index = argv.index("--config")
        self.assertEqual(argv[config_index + 1], "--use-official-api")
        self.assertIn("--yt-dlp-args", argv)
        nested_ytdlp_args = argv[argv.index("--yt-dlp-args") + 1]
        self.assertNotIn("--max-downloads", nested_ytdlp_args)
        self.assertNotIn("--no-plugin-dirs", nested_ytdlp_args)
        self.assertEqual(
            runner.spotdl_config_path,
            Path(env["HOME"]) / ".config" / "spotdl" / "config.json",
        )
        self.assertEqual(runner.spotdl_config["client_id"], "official-client-id")  # type: ignore[index]
        self.assertEqual(runner.spotdl_config["client_secret"], "official-client-secret")  # type: ignore[index]
        self.assertEqual(runner.spotdl_config["audio_providers"], ["youtube-music", "youtube"])  # type: ignore[index]
        self.assertEqual(result.name, "source.m4a")

    def test_subprocess_runner_enforces_timeout(self) -> None:
        runner = SubprocessRunner()
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(IngestError) as raised:
            runner.run(
                ["/bin/sleep", "5"],
                cwd=Path(temporary),
                env={"PATH": "/usr/bin:/bin"},
                timeout_seconds=0.05,
            )
        self.assertEqual(raised.exception.code, "DOWNLOAD_TIMEOUT")


class YoutubeFailureTests(unittest.TestCase):
    def test_bot_checks_fail_immediately_with_actionable_message(self) -> None:
        error = classify_youtube_failure(
            b"ERROR: [youtube] Sign in to confirm you're not a bot"
        )
        self.assertEqual(error.code, "YOUTUBE_ACCESS_BLOCKED")
        self.assertFalse(error.retryable)
        self.assertIn("upload", error.public_message.lower())

    def test_terminal_video_restrictions_do_not_retry(self) -> None:
        restricted = classify_youtube_failure(
            b"ERROR: [youtube] This video is private"
        )
        unavailable = classify_youtube_failure(
            b"ERROR: [youtube] Video unavailable"
        )
        self.assertEqual(restricted.code, "YOUTUBE_RESTRICTED")
        self.assertFalse(restricted.retryable)
        self.assertEqual(unavailable.code, "SOURCE_UNAVAILABLE")
        self.assertFalse(unavailable.retryable)

    def test_transient_network_failure_retries_once(self) -> None:
        error = classify_youtube_failure(
            b"ERROR: Unable to download API page: HTTP Error 503"
        )
        self.assertEqual(error.code, "YOUTUBE_TEMPORARILY_UNAVAILABLE")
        self.assertTrue(error.retryable)
        self.assertNotIn("will retry", error.public_message.lower())

    def test_dns_resolution_failure_retries_once(self) -> None:
        error = classify_youtube_failure(
            b"ERROR: [youtube] Failed to resolve 'www.youtube.com'"
        )
        self.assertEqual(error.code, "YOUTUBE_TEMPORARILY_UNAVAILABLE")
        self.assertTrue(error.retryable)

    def test_pot_provider_transport_failure_retries_once(self) -> None:
        error = classify_youtube_failure(
            b"ERROR: PO Token Provider request timed out with HTTP Error 503"
        )
        self.assertEqual(error.code, "YOUTUBE_TEMPORARILY_UNAVAILABLE")
        self.assertTrue(error.retryable)


class FakeRepository:
    def __init__(self, job: Mapping[str, Any]):
        self.job = dict(job)
        self.stages: list[str] = []
        self.uploaded = False
        self.failed: Mapping[str, str] | None = None
        self.retried: Mapping[str, str] | None = None
        self.upload_outcome_unknown: Mapping[str, str] | None = None

    def claim_job(
        self,
        job_id: str,
        owner_uid: str,
        input_path: str,
        task_name: str,
        lease_until: datetime,
    ) -> ClaimResult:
        del job_id, owner_uid, input_path, task_name, lease_until
        return ClaimResult("claimed", self.job)

    def publish_stage(self, job_id: str, owner_uid: str, stage: str, provider: str) -> None:
        del job_id, owner_uid, provider
        self.stages.append(stage)

    def mark_retryable(self, job_id: str, owner_uid: str, error: Mapping[str, str]) -> None:
        del job_id, owner_uid
        self.retried = error

    def mark_failed(self, job_id: str, owner_uid: str, error: Mapping[str, str]) -> None:
        del job_id, owner_uid
        self.failed = error

    def mark_upload_outcome_unknown(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
    ) -> None:
        del job_id, owner_uid
        self.upload_outcome_unknown = error

    def mark_uploaded(self, job_id: str, owner_uid: str) -> None:
        del job_id, owner_uid
        self.uploaded = True


class FakeMedia:
    def __init__(self, *, error: IngestError | None = None):
        self.error = error

    def download(self, source: Source, work_dir: Path, deadline: Any, client: Any, secret: Any) -> Path:
        del source, deadline, client, secret
        if self.error:
            raise self.error
        path = work_dir / "downloaded.m4a"
        path.write_bytes(b"audio")
        return path

    def probe(self, media_path: Path, work_dir: Path, deadline: Any) -> Any:
        del media_path, work_dir, deadline
        return Mock()

    def normalize(self, source_path: Path, work_dir: Path, deadline: Any) -> Path:
        del source_path, deadline
        path = work_dir / "normalized.m4a"
        path.write_bytes(b"normalized")
        return path


class FakeUploader:
    def __init__(self, error: IngestError | None = None) -> None:
        self.calls = 0
        self.timeout_seconds: float | None = None
        self.error = error

    def put(
        self,
        payload: TaskPayload,
        source_path: Path,
        *,
        timeout_seconds: float | None = None,
    ) -> None:
        del payload, source_path
        self.calls += 1
        self.timeout_seconds = timeout_seconds
        if self.error:
            raise self.error


class WorkerStateTests(unittest.TestCase):
    def make_worker(
        self,
        media: Any,
        uploader_error: IngestError | None = None,
    ) -> tuple[IngestWorker, FakeRepository, FakeUploader]:
        repository = FakeRepository(
            {
                "ownerUid": OWNER,
                "inputPath": INPUT,
                "sourceKind": "remote",
                "sourceProvider": "youtube",
                "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            }
        )
        uploader = FakeUploader(uploader_error)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        worker = IngestWorker(
            repository,
            media,
            uploader,
            work_root=Path(temporary.name),
        )
        return worker, repository, uploader

    def test_success_publishes_safe_stages_and_marks_internal_uploaded(self) -> None:
        worker, repository, uploader = self.make_worker(FakeMedia())
        result = worker.process(
            validate_task_payload(payload_value(), BUCKET),
            task_name=f"download-{JOB}",
            retry_count=0,
        )
        self.assertEqual(result, WorkerResult("accepted"))
        self.assertEqual(repository.stages, ["downloading", "transcoding", "uploading_source"])
        self.assertTrue(repository.uploaded)
        self.assertEqual(uploader.calls, 1)
        self.assertIsNotNone(uploader.timeout_seconds)
        self.assertLessEqual(uploader.timeout_seconds or 0, 1380)

    def test_transient_error_requests_retry_then_becomes_safe_failure(self) -> None:
        error = IngestError("SOURCE_UNAVAILABLE", "Source unavailable.", retryable=True)
        worker, repository, _ = self.make_worker(FakeMedia(error=error))
        first = worker.process(
            validate_task_payload(payload_value(), BUCKET),
            task_name=f"download-{JOB}",
            retry_count=0,
        )
        self.assertTrue(first.retryable)
        self.assertEqual(repository.retried["code"], "SOURCE_UNAVAILABLE")  # type: ignore[index]

        worker, repository, _ = self.make_worker(FakeMedia(error=error))
        last = worker.process(
            validate_task_payload(payload_value(), BUCKET),
            task_name=f"download-{JOB}",
            retry_count=1,
        )
        self.assertFalse(last.retryable)
        self.assertEqual(repository.failed["code"], "SOURCE_UNAVAILABLE")  # type: ignore[index]

    def test_final_ambiguous_upload_leaves_finalize_authoritative(self) -> None:
        error = IngestError(
            "UPLOAD_OUTCOME_UNKNOWN",
            "The private upload result could not be confirmed.",
            retryable=True,
            upload_outcome_unknown=True,
        )
        worker, repository, _ = self.make_worker(FakeMedia(), error)
        first = worker.process(
            validate_task_payload(payload_value(), BUCKET),
            task_name=f"download-{JOB}",
            retry_count=0,
        )
        self.assertEqual(first, WorkerResult("retry", "UPLOAD_OUTCOME_UNKNOWN", True))
        self.assertEqual(repository.retried["code"], "UPLOAD_OUTCOME_UNKNOWN")  # type: ignore[index]

        worker, repository, _ = self.make_worker(FakeMedia(), error)
        final = worker.process(
            validate_task_payload(payload_value(), BUCKET),
            task_name=f"download-{JOB}",
            retry_count=1,
        )
        self.assertEqual(final, WorkerResult("accepted", "UPLOAD_OUTCOME_UNKNOWN"))
        self.assertIsNone(repository.failed)
        self.assertEqual(
            repository.upload_outcome_unknown["code"],  # type: ignore[index]
            "UPLOAD_OUTCOME_UNKNOWN",
        )


class UploadTests(unittest.TestCase):
    def test_signed_put_uses_only_fixed_metadata_headers(self) -> None:
        response = Mock(status_code=200)
        session = Mock()
        session.put.return_value = response
        session.trust_env = True
        with tempfile.TemporaryDirectory() as temporary:
            media = Path(temporary) / "source.m4a"
            media.write_bytes(b"normalized")
            with patch("worker.requests.Session", return_value=session):
                SignedUploader().put(validate_task_payload(payload_value(), BUCKET), media)
        headers = session.put.call_args.kwargs["headers"]
        self.assertEqual(
            headers,
            {
                "Content-Type": "audio/mp4",
                "x-goog-meta-stemulate-source": "remote-import",
                "x-goog-meta-stemulate-job-id": JOB,
            },
        )
        self.assertFalse(session.trust_env)
        self.assertFalse(session.put.call_args.kwargs["allow_redirects"])

    def test_precondition_failure_is_idempotent_success(self) -> None:
        response = Mock(status_code=412)
        session = Mock()
        session.put.return_value = response
        with tempfile.TemporaryDirectory() as temporary:
            media = Path(temporary) / "source.m4a"
            media.write_bytes(b"normalized")
            with patch("worker.requests.Session", return_value=session):
                SignedUploader().put(validate_task_payload(payload_value(), BUCKET), media)

    def test_transport_timeout_is_an_ambiguous_upload_result(self) -> None:
        session = Mock()
        session.put.side_effect = requests.Timeout("response was not received")
        with tempfile.TemporaryDirectory() as temporary:
            media = Path(temporary) / "source.m4a"
            media.write_bytes(b"normalized")
            with (
                patch("worker.requests.Session", return_value=session),
                self.assertRaises(IngestError) as raised,
            ):
                SignedUploader().put(validate_task_payload(payload_value(), BUCKET), media)
        self.assertEqual(raised.exception.code, "UPLOAD_OUTCOME_UNKNOWN")
        self.assertTrue(raised.exception.retryable)
        self.assertTrue(raised.exception.upload_outcome_unknown)


if __name__ == "__main__":
    unittest.main()
