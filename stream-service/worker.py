from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import secrets
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence


LOGGER = logging.getLogger("stemulate.streams")

SAMPLE_RATE = 48_000
PACKET_FRAMES = 1_024
WINDOW_PACKETS = 240
WINDOW_FRAMES = WINDOW_PACKETS * PACKET_FRAMES
MANIFEST_VERSION = 1
CODEC = "mp4a.40.2"
BITSTREAM = "adts"

MAX_TASK_BYTES = 128 * 1024
MAX_OUTPUTS = 40
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_PREVIEW_BYTES = 64 * 1024 * 1024
MAX_TOTAL_PREVIEW_BYTES = 512 * 1024 * 1024
MAX_MANIFEST_BYTES = 512 * 1024
MAX_TRACK_SECONDS = 20 * 60
MAX_PROCESS_SECONDS = 13 * 60

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
OWNER_UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$")
OUTPUT_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

DRUM_COMPONENT_STEMS = (
    "kick",
    "snare",
    "toms",
    "hi_hat",
    "cymbals",
)

CANONICAL_STEMS = (
    "vocals",
    "drums",
    *DRUM_COMPONENT_STEMS,
    "bass",
    "guitars",
    "piano",
    "keys",
    "strings",
    "wind",
    "other",
)

STEM_ALIASES: Mapping[str, frozenset[str]] = {
    "kick": frozenset(
        {"kick", "kicks", "kick_drum", "kick_drums", "kickdrum", "bass_drum"}
    ),
    "snare": frozenset(
        {"snare", "snares", "snare_drum", "snare_drums", "snaredrum"}
    ),
    "toms": frozenset({"tom", "toms", "tom_drum", "tom_drums"}),
    "hi_hat": frozenset(
        {"hi_hat", "hi_hats", "hihat", "hihats", "high_hat", "high_hats"}
    ),
    "cymbals": frozenset({"cymbal", "cymbals"}),
    "vocals": frozenset({"vocal", "vocals", "voice", "voices", "lead_vocal", "lead_vocals"}),
    "drums": frozenset({"drum", "drums", "percussion"}),
    "bass": frozenset({"bass"}),
    "guitars": frozenset({"guitar", "guitars"}),
    "piano": frozenset({"piano"}),
    "keys": frozenset({"key", "keys", "keyboard", "keyboards"}),
    "strings": frozenset({"string", "strings"}),
    "wind": frozenset({"wind", "winds", "woodwind", "woodwinds", "brass"}),
    "other": frozenset(
        {"other", "instrumental", "instruments", "accompaniment", "accompaniments"}
    ),
}

# A component output often contains both a generic drum token and its specific
# part, such as ``drums__kick``. Resolve the five components before ``drums``
# while retaining CANONICAL_STEMS as the stable manifest order.
STEM_MATCH_ORDER = (
    *DRUM_COMPONENT_STEMS,
    *(stem_id for stem_id in CANONICAL_STEMS if stem_id not in DRUM_COMPONENT_STEMS),
)


def log_event(event: str, *, job_id: str | None = None, **fields: Any) -> None:
    """Emit bounded structured events without paths, media names, or tool output."""
    safe: dict[str, Any] = {"event": event}
    if job_id and JOB_ID_RE.fullmatch(job_id):
        safe["jobId"] = job_id
    for key, value in fields.items():
        if key not in {"stage", "code", "retryCount", "stemCount", "exitCode"}:
            continue
        if isinstance(value, (str, int, float, bool)):
            safe[key] = value if not isinstance(value, str) else value[:120]
    LOGGER.info(json.dumps(safe, separators=(",", ":"), sort_keys=True))


class PreviewError(Exception):
    def __init__(self, code: str, public_message: str, *, retryable: bool = False):
        super().__init__(code)
        self.code = code
        self.public_message = public_message
        self.retryable = retryable


class PayloadError(PreviewError):
    pass


class RepositoryContractError(PreviewError):
    pass


@dataclass(frozen=True)
class OutputArtifact:
    key: str
    storage_path: str
    content_type: str | None = None
    size_bytes: int | None = None


@dataclass(frozen=True)
class TaskPayload:
    job_id: str
    owner_uid: str
    attempt: int
    storage_bucket: str
    outputs: tuple[OutputArtifact, ...]
    manifest_path: str


@dataclass(frozen=True)
class ClaimResult:
    state: str


@dataclass(frozen=True)
class WorkerResult:
    state: str
    code: str = ""
    retryable: bool = False


@dataclass(frozen=True)
class ProbeResult:
    duration_seconds: Decimal
    channels: int


@dataclass(frozen=True)
class AdtsPacket:
    byte_start: int
    byte_end_exclusive: int
    channels: int
    sample_rate: int


@dataclass(frozen=True)
class ToolPaths:
    ffmpeg: str = "/usr/bin/ffmpeg"
    ffprobe: str = "/usr/bin/ffprobe"


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes = b""


class JobRepository(Protocol):
    def claim_job(
        self,
        payload: TaskPayload,
        *,
        task_name: str,
        lease_seconds: int,
    ) -> ClaimResult: ...

    def mark_failed(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
        *,
        lease_owner: str,
    ) -> None: ...

    def mark_retryable(
        self,
        job_id: str,
        owner_uid: str,
        error: Mapping[str, str],
        *,
        lease_owner: str,
    ) -> None: ...

    def mark_awaiting_finalize(
        self,
        job_id: str,
        owner_uid: str,
        manifest_path: str,
        *,
        lease_owner: str,
    ) -> None: ...


class ObjectStorage(Protocol):
    def object_exists(self, storage_path: str) -> bool: ...

    def read_bytes(self, storage_path: str, *, maximum_bytes: int) -> bytes: ...

    def download_source(
        self,
        output: OutputArtifact,
        destination: Path,
        *,
        maximum_bytes: int,
    ) -> int: ...

    def upload_file_if_absent(
        self,
        source: Path,
        storage_path: str,
        *,
        content_type: str,
        metadata: Mapping[str, str],
    ) -> None: ...

    def upload_bytes_if_absent(
        self,
        data: bytes,
        storage_path: str,
        *,
        content_type: str,
        metadata: Mapping[str, str],
    ) -> None: ...


class ProcessRunner(Protocol):
    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        capture_stdout: bool = False,
    ) -> ProcessResult: ...


class SubprocessRunner:
    """Run fixed argv without a shell and terminate the complete process group."""

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        capture_stdout: bool = False,
    ) -> ProcessResult:
        if not argv or not Path(argv[0]).is_absolute():
            raise PreviewError("INVALID_TOOL_PATH", "The preview encoder is not configured.")
        if timeout_seconds <= 0:
            raise PreviewError(
                "PREVIEW_TIMEOUT",
                "The preview streams took too long to prepare.",
                retryable=True,
            )
        capture = tempfile.TemporaryFile() if capture_stdout else None
        try:
            process = subprocess.Popen(
                list(argv),
                cwd=cwd,
                env={
                    "PATH": "/usr/bin:/bin",
                    "LANG": "C",
                    "LC_ALL": "C",
                    "HOME": str(cwd),
                },
                stdin=subprocess.DEVNULL,
                stdout=capture if capture is not None else subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                start_new_session=True,
                close_fds=True,
            )
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired as error:
                self._terminate_group(process)
                raise PreviewError(
                    "PREVIEW_TIMEOUT",
                    "The preview streams took too long to prepare.",
                    retryable=True,
                ) from error

            output = b""
            if capture is not None:
                capture.seek(0, os.SEEK_END)
                size = capture.tell()
                if size > 64 * 1024:
                    raise PreviewError(
                        "INVALID_MEDIA",
                        "A stem could not be validated for preview playback.",
                    )
                capture.seek(0)
                output = capture.read()
            return ProcessResult(process.returncode, output)
        finally:
            if capture is not None:
                capture.close()

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
            raise PreviewError(
                "PREVIEW_TIMEOUT",
                "The preview streams took too long to prepare.",
                retryable=True,
            )
        return remaining


def expected_output_prefix(owner_uid: str, job_id: str) -> str:
    return f"users/{owner_uid}/jobs/{job_id}/outputs/"


def expected_stream_prefix(owner_uid: str, job_id: str, attempt: int) -> str:
    return (
        f"users/{owner_uid}/jobs/{job_id}/streams/v1/"
        f"attempt-{attempt}/"
    )


def expected_manifest_path(owner_uid: str, job_id: str, attempt: int) -> str:
    return f"{expected_stream_prefix(owner_uid, job_id, attempt)}manifest.json"


def expected_stream_path(
    owner_uid: str,
    job_id: str,
    attempt: int,
    stem_id: str,
) -> str:
    return f"{expected_stream_prefix(owner_uid, job_id, attempt)}{stem_id}.aac"


def _required_string(
    value: Any,
    pattern: re.Pattern[str],
    code: str = "INVALID_TASK",
) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise PayloadError(code, "The preview task is invalid.")
    return value


def _optional_content_type(value: Any) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or value != value.strip()
        or len(value) > 128
        or "/" not in value
        or not re.fullmatch(r"[\x20-\x7e]+", value)
    ):
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")
    return value.lower()


def _optional_size(value: Any) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")
    if value > MAX_SOURCE_BYTES:
        raise PayloadError("SOURCE_TOO_LARGE", "A source stem is too large to preview.")
    return value


def validate_task_payload(value: Any, configured_bucket: str) -> TaskPayload:
    if not isinstance(value, dict) or set(value) != {
        "jobId",
        "ownerUid",
        "attempt",
        "storageBucket",
        "outputs",
        "manifestPath",
    }:
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")

    job_id = _required_string(value["jobId"], JOB_ID_RE)
    owner_uid = _required_string(value["ownerUid"], OWNER_UID_RE)
    attempt = value["attempt"]
    if (
        not isinstance(attempt, int)
        or isinstance(attempt, bool)
        or attempt < 1
        or attempt > 99
    ):
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")
    bucket = _required_string(value["storageBucket"], BUCKET_RE)
    if bucket != configured_bucket:
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")

    manifest_path = value["manifestPath"]
    if manifest_path != expected_manifest_path(owner_uid, job_id, attempt):
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")

    raw_outputs = value["outputs"]
    if not isinstance(raw_outputs, list) or not 1 <= len(raw_outputs) <= MAX_OUTPUTS:
        raise PayloadError("INVALID_TASK", "The preview task is invalid.")
    prefix = expected_output_prefix(owner_uid, job_id)
    outputs: list[OutputArtifact] = []
    identities: set[tuple[str, str]] = set()
    keys: set[str] = set()
    paths: set[str] = set()
    total_declared_bytes = 0
    for item in raw_outputs:
        if not isinstance(item, dict) or not set(item).issubset(
            {"key", "storagePath", "contentType", "sizeBytes"}
        ) or not {"key", "storagePath"}.issubset(item):
            raise PayloadError("INVALID_TASK", "The preview task is invalid.")
        key = _required_string(item["key"], OUTPUT_KEY_RE)
        storage_path = item["storagePath"]
        if (
            not isinstance(storage_path, str)
            or not storage_path.startswith(prefix)
            or storage_path.count("/") != prefix.count("/")
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,180}", storage_path[len(prefix):])
        ):
            raise PayloadError("INVALID_TASK", "The preview task is invalid.")
        identity = (key, storage_path)
        if identity in identities or key in keys or storage_path in paths:
            raise PayloadError("INVALID_TASK", "The preview task is invalid.")
        identities.add(identity)
        keys.add(key)
        paths.add(storage_path)
        size_bytes = _optional_size(item.get("sizeBytes"))
        if size_bytes is not None:
            total_declared_bytes += size_bytes
            if total_declared_bytes > MAX_TOTAL_SOURCE_BYTES:
                raise PayloadError("SOURCE_TOO_LARGE", "The source stems are too large to preview.")
        outputs.append(
            OutputArtifact(
                key=key,
                storage_path=storage_path,
                content_type=_optional_content_type(item.get("contentType")),
                size_bytes=size_bytes,
            )
        )

    return TaskPayload(
        job_id=job_id,
        owner_uid=owner_uid,
        attempt=attempt,
        storage_bucket=bucket,
        outputs=tuple(outputs),
        manifest_path=manifest_path,
    )


def _name_tokens(value: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", value.lower())
    tokens = set(words)
    # Preserve common compound labels regardless of whether the source uses a
    # space, hyphen, or underscore (hi-hat, hi_hat, and hi hat are equivalent).
    for width in (2, 3):
        tokens.update(
            "_".join(words[start:start + width])
            for start in range(len(words) - width + 1)
        )
    return tokens


def canonical_stem_id(output: OutputArtifact) -> str | None:
    filename = output.storage_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    tokens = _name_tokens(output.key) | _name_tokens(filename)
    for stem_id in STEM_MATCH_ORDER:
        aliases = STEM_ALIASES[stem_id]
        if tokens.intersection(aliases):
            return stem_id
    return None


def select_stem_outputs(outputs: Sequence[OutputArtifact]) -> dict[str, OutputArtifact]:
    selected: dict[str, OutputArtifact] = {}
    for output in outputs:
        if output.content_type and not (
            output.content_type.startswith("audio/")
            or output.content_type == "application/octet-stream"
        ):
            continue
        stem_id = canonical_stem_id(output)
        if stem_id is None:
            continue
        # Match the browser normalizer: the first authoritative output for a
        # canonical stem wins, and namespaced workflow collisions are ignored.
        if stem_id not in selected:
            selected[stem_id] = output
    if not selected:
        raise PreviewError(
            "NO_STEM_OUTPUTS",
            "No supported stem outputs were available for preview playback.",
        )
    return {stem_id: selected[stem_id] for stem_id in CANONICAL_STEMS if stem_id in selected}


def _sample_rate_for_index(index: int) -> int | None:
    values = (
        96_000,
        88_200,
        64_000,
        48_000,
        44_100,
        32_000,
        24_000,
        22_050,
        16_000,
        12_000,
        11_025,
        8_000,
        7_350,
    )
    return values[index] if 0 <= index < len(values) else None


def parse_adts(data: bytes) -> list[AdtsPacket]:
    """Parse and strictly validate one complete AAC-LC ADTS byte stream."""
    if not data:
        raise PreviewError("INVALID_PREVIEW", "An encoded preview stream was empty.")
    packets: list[AdtsPacket] = []
    offset = 0
    while offset < len(data):
        if len(data) - offset < 7:
            raise PreviewError("INVALID_PREVIEW", "An encoded preview stream was truncated.")
        b0, b1, b2, b3, b4, b5, b6 = data[offset:offset + 7]
        if b0 != 0xFF or (b1 & 0xF6) != 0xF0:
            raise PreviewError("INVALID_PREVIEW", "An encoded preview stream had an invalid ADTS header.")
        protection_absent = b1 & 0x01
        profile = (b2 >> 6) & 0x03
        frequency_index = (b2 >> 2) & 0x0F
        sample_rate = _sample_rate_for_index(frequency_index)
        channels = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03)
        frame_length = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07)
        raw_blocks = b6 & 0x03
        header_length = 7 if protection_absent else 9
        if profile != 1 or sample_rate != SAMPLE_RATE or channels not in (1, 2) or raw_blocks != 0:
            raise PreviewError(
                "INVALID_PREVIEW",
                "An encoded preview stream did not match the AAC-LC playback contract.",
            )
        if frame_length < header_length or offset + frame_length > len(data):
            raise PreviewError("INVALID_PREVIEW", "An encoded preview stream was truncated.")
        packets.append(
            AdtsPacket(
                byte_start=offset,
                byte_end_exclusive=offset + frame_length,
                channels=channels,
                sample_rate=sample_rate,
            )
        )
        offset += frame_length
    return packets


def index_adts_file(path: Path) -> tuple[list[AdtsPacket], int]:
    size = path.stat().st_size
    if size <= 0 or size > MAX_PREVIEW_BYTES:
        raise PreviewError("INVALID_PREVIEW", "An encoded preview stream had an invalid size.")
    return parse_adts(path.read_bytes()), size


def build_windows(packets: Sequence[AdtsPacket]) -> list[dict[str, int]]:
    if len(packets) < 2:
        raise PreviewError("INVALID_PREVIEW", "An encoded preview stream was too short.")
    # FFmpeg's AAC encoder emits one priming packet before the requested PCM
    # timeline. Keep it in the object as decoder preroll, but do not expose it
    # as playable media or add it to durationFrames.
    playable_packets = packets[1:]
    windows: list[dict[str, int]] = []
    for start_packet in range(0, len(playable_packets), WINDOW_PACKETS):
        end_packet = min(len(playable_packets), start_packet + WINDOW_PACKETS)
        source_start = start_packet + 1
        source_end = end_packet + 1
        windows.append(
            {
                "startFrame": start_packet * PACKET_FRAMES,
                "frameCount": (end_packet - start_packet) * PACKET_FRAMES,
                "prerollByteStart": packets[source_start - 1].byte_start,
                "byteStart": packets[source_start].byte_start,
                "byteEndExclusive": packets[source_end - 1].byte_end_exclusive,
            }
        )
    return windows


def validate_manifest_bytes(data: bytes, payload: TaskPayload) -> dict[str, Any]:
    if not data or len(data) > MAX_MANIFEST_BYTES:
        raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
    try:
        manifest = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.") from error
    if not isinstance(manifest, dict) or set(manifest) != {
        "version",
        "codec",
        "bitstream",
        "sampleRate",
        "packetFrames",
        "durationFrames",
        "stems",
    }:
        raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
    if (
        not isinstance(manifest["version"], int)
        or isinstance(manifest["version"], bool)
        or manifest["version"] != MANIFEST_VERSION
        or manifest["codec"] != CODEC
        or manifest["bitstream"] != BITSTREAM
        or manifest["sampleRate"] != SAMPLE_RATE
        or manifest["packetFrames"] != PACKET_FRAMES
        or not isinstance(manifest["durationFrames"], int)
        or isinstance(manifest["durationFrames"], bool)
        or manifest["durationFrames"] <= 0
        or manifest["durationFrames"] % PACKET_FRAMES
        or manifest["durationFrames"] > MAX_TRACK_SECONDS * SAMPLE_RATE + PACKET_FRAMES
    ):
        raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
    stems = manifest["stems"]
    if not isinstance(stems, dict) or not stems or not set(stems).issubset(CANONICAL_STEMS):
        raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
    for stem_id, stem in stems.items():
        if not isinstance(stem, dict) or set(stem) != {
            "storagePath",
            "channels",
            "sizeBytes",
            "windows",
        }:
            raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
        if (
            stem["storagePath"]
            != expected_stream_path(
                payload.owner_uid,
                payload.job_id,
                payload.attempt,
                stem_id,
            )
            or not isinstance(stem["channels"], int)
            or isinstance(stem["channels"], bool)
            or stem["channels"] not in (1, 2)
            or not isinstance(stem["sizeBytes"], int)
            or isinstance(stem["sizeBytes"], bool)
            or stem["sizeBytes"] <= 0
            or stem["sizeBytes"] > MAX_PREVIEW_BYTES
            or not isinstance(stem["windows"], list)
            or not stem["windows"]
        ):
            raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
        expected_start = 0
        expected_byte: int | None = None
        for index, window in enumerate(stem["windows"]):
            if not isinstance(window, dict) or set(window) != {
                "startFrame",
                "frameCount",
                "prerollByteStart",
                "byteStart",
                "byteEndExclusive",
            }:
                raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
            count = window["frameCount"]
            preroll_byte = window["prerollByteStart"]
            end_byte = window["byteEndExclusive"]
            if (
                not isinstance(window["startFrame"], int)
                or isinstance(window["startFrame"], bool)
                or window["startFrame"] != expected_start
                or not isinstance(window["byteStart"], int)
                or isinstance(window["byteStart"], bool)
                or (
                    expected_byte is not None
                    and window["byteStart"] != expected_byte
                )
                or not isinstance(preroll_byte, int)
                or isinstance(preroll_byte, bool)
                or (
                    index == 0
                    and (
                        preroll_byte != 0
                        or window["byteStart"] <= preroll_byte
                        or window["byteStart"] - preroll_byte < 7
                        or window["byteStart"] - preroll_byte > 8_191
                    )
                )
                or (
                    index > 0
                    and (
                        preroll_byte < 0
                        or preroll_byte >= window["byteStart"]
                        or window["byteStart"] - preroll_byte < 7
                        or window["byteStart"] - preroll_byte > 8_191
                    )
                )
                or not isinstance(count, int)
                or isinstance(count, bool)
                or count <= 0
                or count % PACKET_FRAMES
                or count > WINDOW_FRAMES
                or (index < len(stem["windows"]) - 1 and count != WINDOW_FRAMES)
                or not isinstance(end_byte, int)
                or isinstance(end_byte, bool)
                or end_byte <= window["byteStart"]
            ):
                raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
            expected_start += count
            expected_byte = end_byte
        if expected_start != manifest["durationFrames"] or expected_byte != stem["sizeBytes"]:
            raise PreviewError("INVALID_MANIFEST", "The stored preview manifest is invalid.")
    return manifest


class MediaPipeline:
    def __init__(
        self,
        runner: ProcessRunner,
        tools: ToolPaths = ToolPaths(),
        *,
        bitrate_kbps: int = 160,
    ):
        if bitrate_kbps < 64 or bitrate_kbps > 320:
            raise ValueError("bitrate_kbps must be between 64 and 320")
        self.runner = runner
        self.tools = tools
        self.bitrate_kbps = bitrate_kbps

    def probe(self, source: Path, *, cwd: Path, deadline: Deadline) -> ProbeResult:
        result = self.runner.run(
            [
                self.tools.ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type,channels:format=duration",
                "-of",
                "json",
                str(source),
            ],
            cwd=cwd,
            timeout_seconds=min(60, deadline.remaining()),
            capture_stdout=True,
        )
        if result.returncode != 0:
            raise PreviewError("INVALID_MEDIA", "A stem could not be decoded for preview playback.")
        try:
            parsed = json.loads(result.stdout)
            streams = parsed["streams"]
            duration = Decimal(str(parsed["format"]["duration"]))
            channels = int(streams[0]["channels"])
        except (KeyError, IndexError, TypeError, ValueError, InvalidOperation, json.JSONDecodeError) as error:
            raise PreviewError("INVALID_MEDIA", "A stem could not be validated for preview playback.") from error
        if (
            len(streams) != 1
            or streams[0].get("codec_type") != "audio"
            or not duration.is_finite()
            or duration <= 0
            or duration > MAX_TRACK_SECONDS
            or channels < 1
            or channels > 32
        ):
            raise PreviewError("INVALID_MEDIA", "A stem could not be validated for preview playback.")
        return ProbeResult(duration_seconds=duration, channels=1 if channels == 1 else 2)

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
        if (
            duration_frames <= 0
            or duration_frames % PACKET_FRAMES
            or duration_frames > MAX_TRACK_SECONDS * SAMPLE_RATE + PACKET_FRAMES
            or channels not in (1, 2)
        ):
            raise PreviewError("INVALID_MEDIA", "The preview duration is invalid.")
        filter_graph = (
            f"aresample={SAMPLE_RATE},"
            "asetpts=N/SR/TB,"
            f"apad=whole_len={duration_frames},"
            f"atrim=end_sample={duration_frames}"
        )
        result = self.runner.run(
            [
                self.tools.ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-vn",
                "-sn",
                "-dn",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-af",
                filter_graph,
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                str(channels),
                "-c:a",
                "aac",
                "-profile:a",
                "aac_low",
                "-b:a",
                f"{self.bitrate_kbps}k",
                "-f",
                "adts",
                str(destination),
            ],
            cwd=cwd,
            timeout_seconds=deadline.remaining(),
        )
        if result.returncode != 0:
            raise PreviewError(
                "PREVIEW_ENCODE_FAILED",
                "A stem could not be encoded for preview playback.",
                retryable=True,
            )
        if not destination.is_file() or destination.is_symlink():
            raise PreviewError("PREVIEW_ENCODE_FAILED", "A preview stream was not created.")


def common_duration_frames(probes: Sequence[ProbeResult]) -> int:
    if not probes:
        raise PreviewError("NO_STEM_OUTPUTS", "No supported stem outputs were available.")
    maximum_seconds = max(probe.duration_seconds for probe in probes)
    frames = int(
        (maximum_seconds * SAMPLE_RATE / PACKET_FRAMES).to_integral_value(
            rounding=ROUND_CEILING
        )
    ) * PACKET_FRAMES
    if frames <= 0 or frames > MAX_TRACK_SECONDS * SAMPLE_RATE + PACKET_FRAMES:
        raise PreviewError("INVALID_MEDIA", "The stem duration is outside the preview limit.")
    return frames


class PreviewWorker:
    def __init__(
        self,
        repository: JobRepository,
        storage: ObjectStorage,
        media: MediaPipeline,
        *,
        work_root: Path,
        max_retry_count: int = 4,
    ):
        self.repository = repository
        self.storage = storage
        self.media = media
        self.work_root = work_root
        self.max_retry_count = max_retry_count

    @staticmethod
    def _safe_error(error: PreviewError) -> dict[str, str]:
        return {
            "code": error.code[:80],
            "message": error.public_message[:300],
        }

    def _process_claimed(self, payload: TaskPayload, lease_owner: str) -> None:
        if self.storage.object_exists(payload.manifest_path):
            stored = self.storage.read_bytes(
                payload.manifest_path,
                maximum_bytes=MAX_MANIFEST_BYTES,
            )
            validate_manifest_bytes(stored, payload)
            self.repository.mark_awaiting_finalize(
                payload.job_id,
                payload.owner_uid,
                payload.manifest_path,
                lease_owner=lease_owner,
            )
            return

        selected = select_stem_outputs(payload.outputs)
        deadline = Deadline(MAX_PROCESS_SECONDS)
        with tempfile.TemporaryDirectory(dir=self.work_root, prefix=f"{payload.job_id}-") as raw:
            work = Path(raw)
            inputs: dict[str, Path] = {}
            total_source_bytes = 0
            probes: dict[str, ProbeResult] = {}
            for stem_id, output in selected.items():
                source = work / f"{stem_id}.source"
                downloaded = self.storage.download_source(
                    output,
                    source,
                    maximum_bytes=MAX_SOURCE_BYTES,
                )
                total_source_bytes += downloaded
                if total_source_bytes > MAX_TOTAL_SOURCE_BYTES:
                    raise PreviewError(
                        "SOURCE_TOO_LARGE",
                        "The source stems are too large to preview.",
                    )
                if not source.is_file() or source.is_symlink():
                    raise PreviewError("INVALID_MEDIA", "A stored stem could not be read safely.")
                inputs[stem_id] = source
                probes[stem_id] = self.media.probe(source, cwd=work, deadline=deadline)

            target_frames = common_duration_frames(tuple(probes.values()))
            indexed: dict[str, tuple[Path, list[AdtsPacket], int]] = {}
            packet_count: int | None = None
            total_preview_bytes = 0
            for stem_id, source in inputs.items():
                encoded = work / f"{stem_id}.aac"
                self.media.encode(
                    source,
                    encoded,
                    duration_frames=target_frames,
                    channels=probes[stem_id].channels,
                    cwd=work,
                    deadline=deadline,
                )
                packets, size_bytes = index_adts_file(encoded)
                total_preview_bytes += size_bytes
                if total_preview_bytes > MAX_TOTAL_PREVIEW_BYTES:
                    raise PreviewError(
                        "PREVIEW_TOO_LARGE",
                        "The preview streams exceeded the service size limit.",
                    )
                if packet_count is None:
                    packet_count = len(packets)
                elif len(packets) != packet_count:
                    raise PreviewError(
                        "UNALIGNED_PREVIEW",
                        "The preview streams could not be aligned to one playback clock.",
                    )
                indexed[stem_id] = (encoded, packets, size_bytes)

            if packet_count is None:
                raise PreviewError("NO_STEM_OUTPUTS", "No preview stems were produced.")
            expected_packet_count = target_frames // PACKET_FRAMES + 1
            if packet_count != expected_packet_count:
                raise PreviewError(
                    "UNALIGNED_PREVIEW",
                    "The preview encoder did not preserve the requested playback timeline.",
                )
            duration_frames = target_frames
            manifest_stems: dict[str, dict[str, Any]] = {}
            for stem_id in CANONICAL_STEMS:
                if stem_id not in indexed:
                    continue
                encoded, packets, size_bytes = indexed[stem_id]
                storage_path = expected_stream_path(
                    payload.owner_uid,
                    payload.job_id,
                    payload.attempt,
                    stem_id,
                )
                sha256 = hashlib.sha256(encoded.read_bytes()).hexdigest()
                self.storage.upload_file_if_absent(
                    encoded,
                    storage_path,
                    content_type="audio/aac",
                    metadata={
                        "stemulate-job-id": payload.job_id,
                        "stemulate-manifest-version": str(MANIFEST_VERSION),
                        "stemulate-preview-attempt": str(payload.attempt),
                        "stemulate-stem-id": stem_id,
                        "sha256": sha256,
                    },
                )
                manifest_stems[stem_id] = {
                    "storagePath": storage_path,
                    "channels": packets[0].channels,
                    "sizeBytes": size_bytes,
                    "windows": build_windows(packets),
                }

            manifest = {
                "version": MANIFEST_VERSION,
                "codec": CODEC,
                "bitstream": BITSTREAM,
                "sampleRate": SAMPLE_RATE,
                "packetFrames": PACKET_FRAMES,
                "durationFrames": duration_frames,
                "stems": manifest_stems,
            }
            manifest_bytes = json.dumps(
                manifest,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            if len(manifest_bytes) > MAX_MANIFEST_BYTES:
                raise PreviewError("INVALID_MANIFEST", "The preview manifest was too large.")
            validate_manifest_bytes(manifest_bytes, payload)
            # Publish awaiting_finalize before the manifest. The Storage
            # finalization transaction is then the only writer that moves this
            # state to ready, and no service write can race behind that event.
            self.repository.mark_awaiting_finalize(
                payload.job_id,
                payload.owner_uid,
                payload.manifest_path,
                lease_owner=lease_owner,
            )
            self.storage.upload_bytes_if_absent(
                manifest_bytes,
                payload.manifest_path,
                content_type="application/json",
                metadata={
                    "stemulate-job-id": payload.job_id,
                    "stemulate-manifest-version": str(MANIFEST_VERSION),
                    "stemulate-preview-attempt": str(payload.attempt),
                    "sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                },
            )

    def process(
        self,
        payload: TaskPayload,
        *,
        task_name: str,
        retry_count: int,
    ) -> WorkerResult:
        lease_owner = (
            f"{task_name}:{retry_count}:{secrets.token_hex(8)}"
        )
        try:
            claim = self.repository.claim_job(
                payload,
                task_name=lease_owner,
                lease_seconds=MAX_PROCESS_SECONDS + 60,
            )
            if claim.state == "ready":
                return WorkerResult("ready")
            if claim.state == "busy":
                return WorkerResult("retry", "PREVIEW_BUSY", True)
            if claim.state != "claimed":
                raise RepositoryContractError(
                    "JOB_NOT_READY",
                    "The processing job is not ready for preview packaging.",
                )
            self._process_claimed(payload, lease_owner)
            log_event(
                "preview_manifest_uploaded",
                job_id=payload.job_id,
                stemCount=len(select_stem_outputs(payload.outputs)),
            )
            return WorkerResult("accepted")
        except PreviewError as error:
            if isinstance(error, RepositoryContractError):
                log_event(
                    "preview_contract_rejected",
                    job_id=payload.job_id,
                    code=error.code,
                )
                return WorkerResult("failed", error.code)
            retryable = error.retryable and retry_count < self.max_retry_count
            log_event(
                "preview_failed",
                job_id=payload.job_id,
                code=error.code,
                retryCount=retry_count,
            )
            if retryable:
                try:
                    self.repository.mark_retryable(
                        payload.job_id,
                        payload.owner_uid,
                        self._safe_error(error),
                        lease_owner=lease_owner,
                    )
                except Exception:
                    return WorkerResult("retry", "STATE_WRITE_FAILED", True)
                return WorkerResult("retry", error.code, True)
            try:
                self.repository.mark_failed(
                    payload.job_id,
                    payload.owner_uid,
                    self._safe_error(error),
                    lease_owner=lease_owner,
                )
            except Exception:
                log_event(
                    "preview_failure_state_write_failed",
                    job_id=payload.job_id,
                    code=type(error).__name__,
                )
                return WorkerResult("retry", "STATE_WRITE_FAILED", True)
            return WorkerResult("failed", error.code)
        except Exception as error:
            safe = PreviewError(
                "PREVIEW_INTERNAL",
                "The preview streams could not be prepared.",
                retryable=True,
            )
            log_event(
                "preview_internal_error",
                job_id=payload.job_id,
                code=type(error).__name__,
                retryCount=retry_count,
            )
            try:
                if retry_count < self.max_retry_count:
                    self.repository.mark_retryable(
                        payload.job_id,
                        payload.owner_uid,
                        self._safe_error(safe),
                        lease_owner=lease_owner,
                    )
                    return WorkerResult("retry", safe.code, True)
                self.repository.mark_failed(
                    payload.job_id,
                    payload.owner_uid,
                    self._safe_error(safe),
                    lease_owner=lease_owner,
                )
                return WorkerResult("failed", safe.code)
            except Exception:
                return WorkerResult("retry", "STATE_WRITE_FAILED", True)
