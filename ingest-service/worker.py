from __future__ import annotations

import json
import logging
import os
import re
import signal
import stat
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence
from urllib.parse import parse_qs, unquote, urlsplit

import requests


LOGGER = logging.getLogger("stemulate.ingest")

MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_TRACK_SECONDS = 20 * 60
# Cloud Tasks and Cloud Run use a 1,500 second request deadline. Keep enough
# margin for the HTTP response and platform teardown while still allowing a
# 20-minute source track to finish normalization and upload.
MAX_PROCESS_SECONDS = 23 * 60
MAX_SIGNED_URL_LENGTH = 8192
MAX_CAPTURED_TOOL_OUTPUT_BYTES = 64 * 1024

JOB_ID_RE = re.compile(r"^[a-f0-9]{32}$")
OWNER_UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$")
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
SPOTIFY_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
SIGNATURE_RE = re.compile(r"^[A-Fa-f0-9]{64,1024}$")

SIGNED_HEADERS = frozenset(
    {
        "content-type",
        "host",
        "x-goog-meta-stemulate-job-id",
        "x-goog-meta-stemulate-source",
    }
)


def log_event(event: str, *, job_id: str | None = None, **fields: Any) -> None:
    """Emit bounded structured data without source or signed URLs."""
    safe: dict[str, Any] = {"event": event}
    if job_id and JOB_ID_RE.fullmatch(job_id):
        safe["jobId"] = job_id
    for key, value in fields.items():
        if key not in {"provider", "stage", "code", "retryCount", "exitCode"}:
            continue
        if isinstance(value, (str, int, float, bool)):
            safe[key] = str(value)[:120] if isinstance(value, str) else value
    LOGGER.info(json.dumps(safe, separators=(",", ":"), sort_keys=True))


class IngestError(Exception):
    def __init__(
        self,
        code: str,
        public_message: str,
        *,
        retryable: bool = False,
        upload_outcome_unknown: bool = False,
    ):
        super().__init__(code)
        self.code = code
        self.public_message = public_message
        self.retryable = retryable
        self.upload_outcome_unknown = upload_outcome_unknown


class PayloadError(IngestError):
    pass


class RepositoryContractError(IngestError):
    pass


@dataclass(frozen=True)
class TaskPayload:
    job_id: str
    owner_uid: str
    storage_bucket: str
    input_path: str
    upload_url: str


@dataclass(frozen=True)
class Source:
    provider: str
    canonical_url: str


@dataclass(frozen=True)
class ClaimResult:
    state: str
    job: Mapping[str, Any]


class JobRepository(Protocol):
    def claim_job(
        self,
        job_id: str,
        owner_uid: str,
        input_path: str,
        task_name: str,
        lease_until: datetime,
    ) -> ClaimResult: ...

    def publish_stage(
        self,
        job_id: str,
        owner_uid: str,
        stage: str,
        provider: str,
    ) -> None: ...

    def mark_retryable(self, job_id: str, owner_uid: str, error: Mapping[str, str]) -> None: ...

    def mark_failed(self, job_id: str, owner_uid: str, error: Mapping[str, str]) -> None: ...

    def mark_upload_outcome_unknown(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
    ) -> None: ...

    def mark_uploaded(self, job_id: str, owner_uid: str) -> None: ...


@dataclass(frozen=True)
class ToolPaths:
    yt_dlp: str = "/usr/local/bin/yt-dlp"
    spotdl: str = "/usr/local/bin/spotdl"
    ffmpeg: str = "/usr/bin/ffmpeg"
    ffprobe: str = "/usr/bin/ffprobe"


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes = b""
    stderr: bytes = b""


class ProcessRunner(Protocol):
    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout_seconds: float,
        capture_stdout: bool = False,
        capture_stderr: bool = False,
    ) -> ProcessResult: ...


class SubprocessRunner:
    """Runs fixed argv without a shell and terminates the entire process group."""

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
        if not argv or not Path(argv[0]).is_absolute():
            raise IngestError("INVALID_TOOL_PATH", "The downloader is not configured correctly.")
        if timeout_seconds <= 0:
            raise IngestError("DOWNLOAD_TIMEOUT", "The track took too long to prepare.")

        stdout_capture = tempfile.TemporaryFile() if capture_stdout else None
        stderr_capture = tempfile.TemporaryFile() if capture_stderr else None
        try:
            process = subprocess.Popen(
                list(argv),
                cwd=cwd,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=stdout_capture if stdout_capture is not None else subprocess.DEVNULL,
                stderr=stderr_capture if stderr_capture is not None else subprocess.DEVNULL,
                shell=False,
                start_new_session=True,
                close_fds=True,
            )
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired as error:
                self._terminate_group(process)
                raise IngestError(
                    "DOWNLOAD_TIMEOUT",
                    "The track took too long to prepare.",
                    retryable=True,
                ) from error

            return ProcessResult(
                process.returncode,
                self._read_capture(stdout_capture),
                self._read_capture(stderr_capture),
            )
        finally:
            if stdout_capture is not None:
                stdout_capture.close()
            if stderr_capture is not None:
                stderr_capture.close()

    @staticmethod
    def _read_capture(capture: Any) -> bytes:
        if capture is None:
            return b""
        capture.seek(0, os.SEEK_END)
        if capture.tell() > MAX_CAPTURED_TOOL_OUTPUT_BYTES:
            raise IngestError(
                "TOOL_OUTPUT_TOO_LARGE",
                "The downloaded media could not be validated.",
            )
        capture.seek(0)
        return capture.read()

    @staticmethod
    def _terminate_group(process: subprocess.Popen[Any]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


class Deadline:
    def __init__(self, seconds: int):
        self._ends_at = time.monotonic() + seconds

    def remaining(self) -> float:
        remaining = self._ends_at - time.monotonic()
        if remaining <= 0:
            raise IngestError(
                "DOWNLOAD_TIMEOUT",
                "The track took too long to prepare.",
                retryable=True,
            )
        return remaining


def required_job_id(value: Any) -> str:
    if not isinstance(value, str) or not JOB_ID_RE.fullmatch(value):
        raise PayloadError("INVALID_TASK", "The task job ID is invalid.")
    return value


def required_owner_uid(value: Any) -> str:
    if not isinstance(value, str) or not OWNER_UID_RE.fullmatch(value):
        raise PayloadError("INVALID_TASK", "The task owner ID is invalid.")
    return value


def expected_input_path(owner_uid: str, job_id: str) -> str:
    return f"users/{owner_uid}/jobs/{job_id}/input/source.m4a"


def _single_query_value(query: Mapping[str, list[str]], key: str) -> str:
    values = query.get(key)
    if not values or len(values) != 1 or not values[0]:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    return values[0]


def validate_signed_upload_url(
    upload_url: Any,
    storage_bucket: str,
    input_path: str,
) -> str:
    if not isinstance(upload_url, str) or not upload_url or len(upload_url) > MAX_SIGNED_URL_LENGTH:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    try:
        parsed = urlsplit(upload_url)
    except ValueError as error:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.") from error

    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.fragment
    ):
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")

    host = (parsed.hostname or "").lower()
    decoded_path = unquote(parsed.path)
    if host == "storage.googleapis.com":
        expected_path = f"/{storage_bucket}/{input_path}"
    elif host == f"{storage_bucket}.storage.googleapis.com":
        expected_path = f"/{input_path}"
    else:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    if decoded_path != expected_path:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")

    query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    if _single_query_value(query, "X-Goog-Algorithm") != "GOOG4-RSA-SHA256":
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    _single_query_value(query, "X-Goog-Credential")
    date = _single_query_value(query, "X-Goog-Date")
    if not re.fullmatch(r"\d{8}T\d{6}Z", date):
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    try:
        expires = int(_single_query_value(query, "X-Goog-Expires"))
    except ValueError as error:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.") from error
    if expires < 60 or expires > 86_400:
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    signature = _single_query_value(query, "X-Goog-Signature")
    if not SIGNATURE_RE.fullmatch(signature):
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    signed_headers = {
        header.strip().lower()
        for header in _single_query_value(query, "X-Goog-SignedHeaders").split(";")
        if header.strip()
    }
    if not SIGNED_HEADERS.issubset(signed_headers):
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    if _single_query_value(query, "ifGenerationMatch") != "0":
        raise PayloadError("INVALID_UPLOAD_URL", "The private upload destination is invalid.")
    return upload_url


def validate_task_payload(value: Any, configured_bucket: str) -> TaskPayload:
    if not isinstance(value, Mapping):
        raise PayloadError("INVALID_TASK", "The download task is invalid.")
    job_id = required_job_id(value.get("jobId"))
    owner_uid = required_owner_uid(value.get("ownerUid"))
    storage_bucket = value.get("storageBucket")
    if (
        not isinstance(storage_bucket, str)
        or not BUCKET_RE.fullmatch(storage_bucket)
        or storage_bucket != configured_bucket
    ):
        raise PayloadError("INVALID_TASK", "The task storage bucket is invalid.")
    input_path = value.get("inputPath")
    expected = expected_input_path(owner_uid, job_id)
    if input_path != expected:
        raise PayloadError("INVALID_TASK", "The task input path is invalid.")
    upload_url = validate_signed_upload_url(
        value.get("uploadUrl"),
        storage_bucket,
        input_path,
    )
    return TaskPayload(job_id, owner_uid, storage_bucket, input_path, upload_url)


def canonicalize_source_url(value: Any) -> Source:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise IngestError("UNSUPPORTED_SOURCE", "Use a single YouTube or Spotify track URL.")
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise IngestError("UNSUPPORTED_SOURCE", "Use a single YouTube or Spotify track URL.") from error
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.fragment
    ):
        raise IngestError("UNSUPPORTED_SOURCE", "Use a single YouTube or Spotify track URL.")

    host = (parsed.hostname or "").lower()
    if host == "www.youtube.com" and parsed.path == "/watch":
        query = parse_qs(parsed.query, keep_blank_values=False)
        if set(query) != {"v"} or len(query["v"]) != 1:
            raise IngestError("NOT_SINGLE_TRACK", "Use one YouTube video, not a playlist.")
        video_id = query["v"][0]
        if not YOUTUBE_ID_RE.fullmatch(video_id):
            raise IngestError("UNSUPPORTED_SOURCE", "The YouTube track URL is invalid.")
        return Source("youtube", f"https://www.youtube.com/watch?v={video_id}")

    if host == "open.spotify.com" and not parsed.query:
        match = re.fullmatch(r"/track/([A-Za-z0-9]{22})/?", parsed.path)
        if match:
            track_id = match.group(1)
            return Source("spotify", f"https://open.spotify.com/track/{track_id}")

    raise IngestError("UNSUPPORTED_SOURCE", "Use a single YouTube or Spotify track URL.")


def isolated_child_environment(work_dir: Path) -> dict[str, str]:
    home = work_dir / "home"
    config = work_dir / "xdg-config"
    cache = work_dir / "xdg-cache"
    data = work_dir / "xdg-data"
    deno = work_dir / "deno"
    for directory in (home, config, cache, data, deno):
        directory.mkdir(mode=0o700, exist_ok=True)
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(config),
        "XDG_CACHE_HOME": str(cache),
        "XDG_DATA_HOME": str(data),
        "DENO_DIR": str(deno),
        "TMPDIR": str(work_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PYTHONNOUSERSITE": "1",
    }


def classify_youtube_failure(stderr: bytes) -> IngestError:
    """Map bounded yt-dlp diagnostics to safe, actionable public failures."""
    diagnostic = stderr.decode("utf-8", errors="replace").lower()
    transient_markers = (
        "http error 429",
        "too many requests",
        "timed out",
        "timeout",
        "temporary failure",
        "failed to resolve",
        "name resolution",
        "connection reset",
        "connection refused",
        "network is unreachable",
        "remote end closed connection",
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
    )

    if any(
        marker in diagnostic
        for marker in (
            "private video",
            "this video is private",
            "members-only",
            "members only",
            "join this channel",
            "premium content",
            "sign in to confirm your age",
            "age-restricted",
            "age restricted",
            "login required",
        )
    ):
        return IngestError(
            "YOUTUBE_RESTRICTED",
            "This YouTube video is private, age-restricted, members-only, or requires sign-in. Use a public video or upload the audio file.",
        )

    if any(
        marker in diagnostic
        for marker in (
            "not available in your country",
            "geo-restricted",
            "geo restricted",
            "geographic restriction",
        )
    ):
        return IngestError(
            "YOUTUBE_REGION_RESTRICTED",
            "This YouTube video is not available from the downloader's region. Upload an authorized audio file instead.",
        )

    if any(
        marker in diagnostic
        for marker in (
            "premieres in ",
            "this live event will begin",
            "is live",
            "live videos are not supported",
            "does not pass filter (!is_live & duration <=",
        )
    ):
        return IngestError(
            "YOUTUBE_VIDEO_UNSUPPORTED",
            "Live videos and videos longer than 20 minutes cannot be imported. Use one public, finished video up to 20 minutes.",
        )

    if any(
        marker in diagnostic
        for marker in (
            "larger than max-filesize",
            "larger than max filesize",
            "file is larger than",
        )
    ):
        return IngestError(
            "SOURCE_TOO_LARGE",
            "The source track exceeds the 100 MiB limit.",
        )

    if any(
        marker in diagnostic
        for marker in (
            "no supported javascript runtime",
            "javascript runtime is not available",
            "challenge solver is not available",
            "yt-dlp-ejs",
            "ejs challenge",
        )
    ):
        return IngestError(
            "YOUTUBE_RUNTIME_UNAVAILABLE",
            "The YouTube importer needs a service update before it can process this video.",
        )

    if any(
        marker in diagnostic
        for marker in transient_markers
    ):
        return IngestError(
            "YOUTUBE_TEMPORARILY_UNAVAILABLE",
            "YouTube could not be reached. Try again later.",
            retryable=True,
        )

    if any(
        marker in diagnostic
        for marker in (
            "sign in to confirm you're not a bot",
            "sign in to confirm you’re not a bot",
            "proof of origin",
            "po token",
            "pot provider",
            "http error 403",
        )
    ):
        return IngestError(
            "YOUTUBE_ACCESS_BLOCKED",
            "YouTube blocked this server-side download. Try again later or upload an authorized audio file.",
        )

    if any(
        marker in diagnostic
        for marker in (
            "video unavailable",
            "this video is unavailable",
            "video has been removed",
            "account associated with this video has been terminated",
            "requested format is not available",
            "no video formats found",
        )
    ):
        return IngestError(
            "SOURCE_UNAVAILABLE",
            "This YouTube video is unavailable or has no downloadable audio. Try another public video or upload the audio file.",
        )

    return IngestError(
        "SOURCE_UNAVAILABLE",
        "The source track is unavailable or could not be downloaded. Try another public video or upload the audio file.",
    )


def exactly_one_regular_file(directory: Path, max_bytes: int) -> Path:
    regular_files: list[Path] = []
    root = directory.resolve()
    for candidate in directory.rglob("*"):
        if candidate.is_symlink():
            raise IngestError("UNSAFE_DOWNLOAD", "The downloaded media was not a regular file.")
        details = candidate.lstat()
        if stat.S_ISREG(details.st_mode):
            if details.st_nlink != 1:
                raise IngestError("UNSAFE_DOWNLOAD", "The downloaded media was not a regular file.")
            resolved = candidate.resolve()
            if not resolved.is_relative_to(root):
                raise IngestError("UNSAFE_DOWNLOAD", "The downloaded media escaped its work area.")
            if details.st_size <= 0 or details.st_size > max_bytes:
                raise IngestError("SOURCE_TOO_LARGE", "The source track exceeds the 100 MiB limit.")
            regular_files.append(candidate)
        elif not stat.S_ISDIR(details.st_mode):
            raise IngestError("UNSAFE_DOWNLOAD", "The downloaded media was not a regular file.")
    if len(regular_files) != 1:
        raise IngestError("NOT_SINGLE_TRACK", "The source did not produce exactly one track.")
    return regular_files[0]


@dataclass(frozen=True)
class Probe:
    duration: float
    stream_types: tuple[str, ...]


class MediaPipeline:
    def __init__(
        self,
        runner: ProcessRunner,
        tools: ToolPaths,
        *,
        max_bytes: int = MAX_SOURCE_BYTES,
        max_track_seconds: int = MAX_TRACK_SECONDS,
        youtube_pot_provider_url: str | None = None,
    ):
        self.runner = runner
        self.tools = tools
        self.max_bytes = max_bytes
        self.max_track_seconds = max_track_seconds
        self.youtube_pot_provider_url = youtube_pot_provider_url

    def download(
        self,
        source: Source,
        work_dir: Path,
        deadline: Deadline,
        spotify_client_id: str | None,
        spotify_client_secret: str | None,
    ) -> Path:
        download_dir = work_dir / "download"
        download_dir.mkdir(mode=0o700)
        env = isolated_child_environment(work_dir)

        if source.provider == "youtube":
            argv = [
                self.tools.yt_dlp,
                "--ignore-config",
                "--no-remote-components",
                "--no-cookies",
                "--no-cache-dir",
                "--no-playlist",
                "--no-write-playlist-metafiles",
                "--abort-on-error",
                "--quiet",
                "--no-progress",
                "--no-warnings",
                "--js-runtimes",
                "deno:/usr/local/bin/deno",
                "--socket-timeout",
                "30",
                "--retries",
                "2",
                "--fragment-retries",
                "2",
                "--max-filesize",
                str(self.max_bytes),
                "--match-filters",
                f"!is_live & duration <= {self.max_track_seconds}",
                "--format",
                "bestaudio/best",
                "--output",
                str(download_dir / "source.%(ext)s"),
                source.canonical_url,
            ]
            if self.youtube_pot_provider_url:
                argv[-1:-1] = [
                    "--extractor-args",
                    "youtube:player_client=default,mweb;fetch_pot=auto",
                    "--extractor-args",
                    f"youtubepot-bgutilhttp:base_url={self.youtube_pot_provider_url}",
                ]
        else:
            if not spotify_client_id or not spotify_client_secret:
                raise IngestError(
                    "SPOTIFY_NOT_CONFIGURED",
                    "Spotify importing is not configured on this STEMulate backend.",
                )
            # spotDL 4.5.2 resolves its Linux config from
            # $HOME/.config/spotdl/config.json (not XDG_CONFIG_HOME). HOME is
            # an isolated per-task directory, so credentials cannot leak into
            # the image user's profile or survive task cleanup.
            config_dir = Path(env["HOME"]) / ".config" / "spotdl"
            config_dir.mkdir(mode=0o700, parents=True)
            config_path = config_dir / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "client_id": spotify_client_id,
                        "client_secret": spotify_client_secret,
                        "user_auth": False,
                        "headless": True,
                        "no_cache": True,
                        "max_retries": 2,
                        "audio_providers": ["youtube-music", "youtube"],
                        "lyrics_providers": [],
                        "threads": 1,
                    },
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
            config_path.chmod(0o600)
            argv = [
                self.tools.spotdl,
                "download",
                source.canonical_url,
                "--config",
                "--use-official-api",
                "--format",
                "m4a",
                "--output",
                str(download_dir / "source.{output-ext}"),
                "--threads",
                "1",
                "--no-cache",
                "--max-retries",
                "2",
                "--headless",
                "--audio",
                "youtube-music",
                "youtube",
                "--skip-album-art",
                "--yt-dlp-args",
                "--ignore-config --no-remote-components --no-cookies --no-cache-dir --no-playlist --abort-on-error --max-filesize 104857600 --no-progress",
            ]

        result = self.runner.run(
            argv,
            cwd=work_dir,
            env=env,
            timeout_seconds=deadline.remaining(),
            capture_stderr=source.provider == "youtube",
        )
        if result.returncode != 0:
            if source.provider == "youtube":
                raise classify_youtube_failure(result.stderr)
            raise IngestError(
                "SOURCE_UNAVAILABLE",
                "The source track is unavailable or could not be matched.",
                retryable=True,
            )
        return exactly_one_regular_file(download_dir, self.max_bytes)

    def probe(self, media_path: Path, work_dir: Path, deadline: Deadline) -> Probe:
        result = self.runner.run(
            [
                self.tools.ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type",
                "-of",
                "json",
                str(media_path),
            ],
            cwd=work_dir,
            env=isolated_child_environment(work_dir),
            timeout_seconds=min(60, deadline.remaining()),
            capture_stdout=True,
        )
        if result.returncode != 0:
            raise IngestError("INVALID_MEDIA", "The downloaded track is not valid audio.")
        try:
            value = json.loads(result.stdout.decode("utf-8"))
            duration = float(value["format"]["duration"])
            stream_types = tuple(
                str(stream["codec_type"])
                for stream in value.get("streams", [])
                if isinstance(stream, Mapping) and "codec_type" in stream
            )
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise IngestError("INVALID_MEDIA", "The downloaded track is not valid audio.") from error
        if duration <= 0 or duration > self.max_track_seconds:
            raise IngestError(
                "TRACK_TOO_LONG",
                "Tracks must be 20 minutes or shorter.",
            )
        if "audio" not in stream_types:
            raise IngestError("INVALID_MEDIA", "The downloaded track does not contain audio.")
        return Probe(duration, stream_types)

    def normalize(self, source_path: Path, work_dir: Path, deadline: Deadline) -> Path:
        normalized_dir = work_dir / "normalized"
        normalized_dir.mkdir(mode=0o700)
        destination = normalized_dir / "source.m4a"
        result = self.runner.run(
            [
                self.tools.ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source_path),
                "-map",
                "0:a:0",
                "-vn",
                "-sn",
                "-dn",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-threads",
                "1",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "-n",
                str(destination),
            ],
            cwd=work_dir,
            env=isolated_child_environment(work_dir),
            timeout_seconds=deadline.remaining(),
        )
        if result.returncode != 0:
            raise IngestError("TRANSCODE_FAILED", "The track could not be converted to M4A audio.")
        normalized = exactly_one_regular_file(normalized_dir, self.max_bytes)
        probe = self.probe(normalized, work_dir, deadline)
        if probe.stream_types != ("audio",):
            raise IngestError("TRANSCODE_FAILED", "The normalized track was not audio-only.")
        return normalized


class SignedUploader:
    def __init__(self, timeout_seconds: int = 300):
        self.timeout_seconds = timeout_seconds

    def put(
        self,
        payload: TaskPayload,
        source_path: Path,
        *,
        timeout_seconds: float | None = None,
    ) -> None:
        headers = {
            "Content-Type": "audio/mp4",
            "x-goog-meta-stemulate-source": "remote-import",
            "x-goog-meta-stemulate-job-id": payload.job_id,
        }
        session = requests.Session()
        session.trust_env = False
        try:
            with source_path.open("rb") as source:
                response = session.put(
                    payload.upload_url,
                    data=source,
                    headers=headers,
                    allow_redirects=False,
                    timeout=(10, max(1, min(self.timeout_seconds, timeout_seconds or self.timeout_seconds))),
                )
        except (requests.Timeout, requests.ConnectionError) as error:
            # A transport failure can happen after GCS committed the object but
            # before its response reached this worker. The first attempt can
            # safely retry against ifGenerationMatch=0; the final attempt must
            # leave awaiting_upload open for the Storage finalize event.
            raise IngestError(
                "UPLOAD_OUTCOME_UNKNOWN",
                "The private upload result could not be confirmed.",
                retryable=True,
                upload_outcome_unknown=True,
            ) from error
        except OSError as error:
            raise IngestError(
                "UPLOAD_UNAVAILABLE",
                "The private upload could not be completed.",
                retryable=True,
            ) from error
        finally:
            session.close()

        if response.status_code in (200, 201, 204, 412):
            return
        if response.status_code == 403:
            raise IngestError(
                "UPLOAD_AUTH_EXPIRED",
                "The private upload authorization expired before the track was ready.",
            )
        if response.status_code == 429 or response.status_code >= 500:
            raise IngestError(
                "UPLOAD_UNAVAILABLE",
                "The private upload could not be completed.",
                retryable=True,
            )
        raise IngestError("UPLOAD_REJECTED", "The private upload was rejected.")


@dataclass(frozen=True)
class WorkerResult:
    status: str
    code: str | None = None
    retryable: bool = False


class IngestWorker:
    def __init__(
        self,
        repository: JobRepository,
        media: MediaPipeline,
        uploader: SignedUploader,
        *,
        spotify_client_id: str | None = None,
        spotify_client_secret: str | None = None,
        max_process_seconds: int = MAX_PROCESS_SECONDS,
        max_retry_count: int = 1,
        work_root: Path = Path("/tmp"),
    ):
        self.repository = repository
        self.media = media
        self.uploader = uploader
        self.spotify_client_id = spotify_client_id
        self.spotify_client_secret = spotify_client_secret
        self.max_process_seconds = max_process_seconds
        self.max_retry_count = max_retry_count
        self.work_root = work_root

    def process(
        self,
        payload: TaskPayload,
        *,
        task_name: str,
        retry_count: int,
    ) -> WorkerResult:
        try:
            claim = self.repository.claim_job(
                payload.job_id,
                payload.owner_uid,
                payload.input_path,
                task_name,
                datetime.now(timezone.utc) + timedelta(seconds=self.max_process_seconds + 60),
            )
        except RepositoryContractError:
            log_event("job_contract_rejected", job_id=payload.job_id, code="JOB_MISMATCH")
            return WorkerResult("rejected", "JOB_MISMATCH")

        if claim.state in {"uploaded", "terminal"}:
            log_event("job_already_terminal", job_id=payload.job_id, stage=claim.state)
            return WorkerResult("accepted")
        if claim.state == "busy":
            return WorkerResult("retry", "JOB_BUSY", True)

        try:
            source = self._validate_claimed_job(claim.job, payload)
            log_event(
                "ingest_started",
                job_id=payload.job_id,
                provider=source.provider,
                retryCount=retry_count,
            )
            self.repository.publish_stage(
                payload.job_id,
                payload.owner_uid,
                "downloading",
                source.provider,
            )
            deadline = Deadline(self.max_process_seconds)
            self.work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="stemulate-", dir=self.work_root) as temporary:
                work_dir = Path(temporary)
                downloaded = self.media.download(
                    source,
                    work_dir,
                    deadline,
                    self.spotify_client_id,
                    self.spotify_client_secret,
                )
                self.media.probe(downloaded, work_dir, deadline)
                self.repository.publish_stage(
                    payload.job_id,
                    payload.owner_uid,
                    "transcoding",
                    source.provider,
                )
                normalized = self.media.normalize(downloaded, work_dir, deadline)
                self.repository.publish_stage(
                    payload.job_id,
                    payload.owner_uid,
                    "uploading_source",
                    source.provider,
                )
                self.uploader.put(
                    payload,
                    normalized,
                    timeout_seconds=deadline.remaining(),
                )

            # Do not update the public stage here. The Storage finalize event owns
            # the transition to queued_for_analysis, including the 412 retry case.
            self.repository.mark_uploaded(payload.job_id, payload.owner_uid)
            log_event(
                "ingest_uploaded",
                job_id=payload.job_id,
                provider=source.provider,
            )
            return WorkerResult("accepted")
        except IngestError as error:
            return self._handle_error(payload, error, retry_count)
        except Exception as error:  # Keep implementation details out of logs and Firestore.
            log_event(
                "ingest_internal_error",
                job_id=payload.job_id,
                code=type(error).__name__,
                retryCount=retry_count,
            )
            return self._handle_error(
                payload,
                IngestError(
                    "INGEST_UNAVAILABLE",
                    "The remote track importer is temporarily unavailable.",
                    retryable=True,
                ),
                retry_count,
            )

    @staticmethod
    def _validate_claimed_job(job: Mapping[str, Any], payload: TaskPayload) -> Source:
        if (
            job.get("ownerUid") != payload.owner_uid
            or job.get("inputPath") != payload.input_path
            or job.get("sourceKind", "remote") != "remote"
        ):
            raise IngestError("JOB_MISMATCH", "The private import job is invalid.")
        source = canonicalize_source_url(job.get("sourceUrl"))
        configured_provider = job.get("sourceProvider")
        if configured_provider not in (None, source.provider):
            raise IngestError("JOB_MISMATCH", "The private import job is invalid.")
        return source

    def _handle_error(
        self,
        payload: TaskPayload,
        error: IngestError,
        retry_count: int,
    ) -> WorkerResult:
        public_error = {"code": error.code, "message": error.public_message[:300]}
        if error.retryable and retry_count < self.max_retry_count:
            self.repository.mark_retryable(payload.job_id, payload.owner_uid, public_error)
            log_event(
                "ingest_retry",
                job_id=payload.job_id,
                code=error.code,
                retryCount=retry_count,
            )
            return WorkerResult("retry", error.code, True)
        if error.upload_outcome_unknown:
            # Do not mark this job failed: GCS may already have committed the
            # signed, generation-zero PUT. A valid Storage finalize event is
            # authoritative and can still advance awaiting_upload to queued;
            # the scheduled stale-import cleanup handles the no-object case.
            self.repository.mark_upload_outcome_unknown(
                payload.job_id,
                payload.owner_uid,
                public_error,
            )
            log_event(
                "ingest_upload_outcome_unknown",
                job_id=payload.job_id,
                code=error.code,
                retryCount=retry_count,
            )
            return WorkerResult("accepted", error.code)
        self.repository.mark_failed(payload.job_id, payload.owner_uid, public_error)
        log_event(
            "ingest_failed",
            job_id=payload.job_id,
            code=error.code,
            retryCount=retry_count,
        )
        return WorkerResult("failed", error.code)
