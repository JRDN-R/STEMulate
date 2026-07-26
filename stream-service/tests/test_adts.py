from __future__ import annotations

import json
import unittest

from worker import (
    PACKET_FRAMES,
    SAMPLE_RATE,
    WINDOW_FRAMES,
    OutputArtifact,
    PreviewError,
    build_windows,
    expected_manifest_path,
    expected_stream_path,
    parse_adts,
    validate_manifest_bytes,
    validate_task_payload,
)


BUCKET = "stem-ulate.firebasestorage.app"
OWNER = "owner_123"
JOB = "0123456789abcdef0123456789abcdef"
ATTEMPT = 1


def adts_frame(
    payload_size: int = 11,
    *,
    profile: int = 1,
    frequency_index: int = 3,
    channels: int = 2,
    raw_blocks: int = 0,
    protection_absent: bool = True,
) -> bytes:
    header_size = 7 if protection_absent else 9
    frame_length = header_size + payload_size
    header = bytearray(header_size)
    header[0] = 0xFF
    header[1] = 0xF0 | (1 if protection_absent else 0)
    header[2] = (
        ((profile & 0x03) << 6)
        | ((frequency_index & 0x0F) << 2)
        | ((channels >> 2) & 0x01)
    )
    header[3] = ((channels & 0x03) << 6) | ((frame_length >> 11) & 0x03)
    header[4] = (frame_length >> 3) & 0xFF
    header[5] = ((frame_length & 0x07) << 5) | 0x1F
    header[6] = 0xFC | (raw_blocks & 0x03)
    return bytes(header) + bytes([0xA5]) * payload_size


def payload_value() -> dict:
    return {
        "jobId": JOB,
        "ownerUid": OWNER,
        "attempt": ATTEMPT,
        "storageBucket": BUCKET,
        "outputs": [
            {
                "key": "vocals",
                "storagePath": f"users/{OWNER}/jobs/{JOB}/outputs/vocals.wav",
                "contentType": "audio/wav",
                "sizeBytes": 1000,
            }
        ],
        "manifestPath": expected_manifest_path(OWNER, JOB, ATTEMPT),
    }


class AdtsParserTests(unittest.TestCase):
    def test_parses_aac_lc_packets_and_exact_byte_boundaries(self) -> None:
        first = adts_frame(9, channels=1)
        second = adts_frame(17, channels=1)
        packets = parse_adts(first + second)
        self.assertEqual(len(packets), 2)
        self.assertEqual(packets[0].byte_start, 0)
        self.assertEqual(packets[0].byte_end_exclusive, len(first))
        self.assertEqual(packets[1].byte_start, len(first))
        self.assertEqual(packets[1].byte_end_exclusive, len(first) + len(second))
        self.assertEqual(packets[0].channels, 1)
        self.assertEqual(packets[0].sample_rate, SAMPLE_RATE)

    def test_accepts_crc_header_but_rejects_non_contract_streams(self) -> None:
        self.assertEqual(len(parse_adts(adts_frame(protection_absent=False))), 1)
        invalid = [
            adts_frame(profile=0),
            adts_frame(frequency_index=4),
            adts_frame(channels=0),
            adts_frame(channels=3),
            adts_frame(raw_blocks=1),
            b"\x00" + adts_frame(),
            adts_frame()[:-1],
            b"",
        ]
        for stream in invalid:
            with self.subTest(stream=stream[:8]):
                with self.assertRaises(PreviewError):
                    parse_adts(stream)

    def test_windows_are_240_packet_contiguous_byte_ranges(self) -> None:
        frame = adts_frame(13)
        packets = parse_adts(frame * 482)
        windows = build_windows(packets)
        self.assertEqual(len(windows), 3)
        self.assertEqual(
            windows[0],
            {
                "startFrame": 0,
                "frameCount": WINDOW_FRAMES,
                "prerollByteStart": 0,
                "byteStart": len(frame),
                "byteEndExclusive": len(frame) * 241,
            },
        )
        self.assertEqual(windows[1]["startFrame"], WINDOW_FRAMES)
        self.assertEqual(windows[1]["byteStart"], windows[0]["byteEndExclusive"])
        self.assertEqual(
            windows[1]["prerollByteStart"],
            windows[0]["byteEndExclusive"] - len(frame),
        )
        self.assertEqual(windows[2]["frameCount"], PACKET_FRAMES)
        self.assertEqual(windows[2]["byteEndExclusive"], len(frame) * 482)


class ManifestContractTests(unittest.TestCase):
    def test_validates_exact_v1_manifest_contract(self) -> None:
        packet = adts_frame()
        packets = parse_adts(packet * 3)
        manifest = {
            "version": 1,
            "codec": "mp4a.40.2",
            "bitstream": "adts",
            "sampleRate": 48000,
            "packetFrames": 1024,
            "durationFrames": 2 * 1024,
            "stems": {
                "vocals": {
                    "storagePath": expected_stream_path(
                        OWNER,
                        JOB,
                        ATTEMPT,
                        "vocals",
                    ),
                    "channels": 2,
                    "sizeBytes": len(packet) * 3,
                    "windows": build_windows(packets),
                }
            },
        }
        payload = validate_task_payload(payload_value(), BUCKET)
        parsed = validate_manifest_bytes(
            json.dumps(manifest, separators=(",", ":")).encode(),
            payload,
        )
        self.assertEqual(parsed["codec"], "mp4a.40.2")

    def test_accepts_canonical_drum_component_stems(self) -> None:
        packet = adts_frame()
        packets = parse_adts(packet * 3)
        component_ids = ("kick", "snare", "toms", "hi_hat", "cymbals")
        manifest = {
            "version": 1,
            "codec": "mp4a.40.2",
            "bitstream": "adts",
            "sampleRate": 48000,
            "packetFrames": 1024,
            "durationFrames": 2 * 1024,
            "stems": {
                stem_id: {
                    "storagePath": expected_stream_path(
                        OWNER,
                        JOB,
                        ATTEMPT,
                        stem_id,
                    ),
                    "channels": 2,
                    "sizeBytes": len(packet) * 3,
                    "windows": build_windows(packets),
                }
                for stem_id in component_ids
            },
        }
        payload = validate_task_payload(payload_value(), BUCKET)

        parsed = validate_manifest_bytes(
            json.dumps(manifest, separators=(",", ":")).encode(),
            payload,
        )

        self.assertEqual(tuple(parsed["stems"]), component_ids)

    def test_rejects_path_window_duration_and_schema_deviations(self) -> None:
        packet = adts_frame()
        packets = parse_adts(packet * 2)
        base = {
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
                    "windows": build_windows(packets),
                }
            },
        }
        payload = validate_task_payload(payload_value(), BUCKET)
        mutations = []
        wrong_path = json.loads(json.dumps(base))
        wrong_path["stems"]["vocals"]["storagePath"] = "users/other/jobs/bad/vocals.aac"
        mutations.append(wrong_path)
        wrong_duration = json.loads(json.dumps(base))
        wrong_duration["durationFrames"] = 2048
        mutations.append(wrong_duration)
        gap = json.loads(json.dumps(base))
        gap["stems"]["vocals"]["windows"][0]["byteStart"] = 0
        mutations.append(gap)
        oversized_preroll = json.loads(json.dumps(base))
        oversized_preroll["stems"]["vocals"]["windows"][0]["prerollByteStart"] = 1
        mutations.append(oversized_preroll)
        extra = json.loads(json.dumps(base))
        extra["unexpected"] = True
        mutations.append(extra)
        for manifest in mutations:
            with self.subTest(manifest=manifest):
                with self.assertRaises(PreviewError):
                    validate_manifest_bytes(json.dumps(manifest).encode(), payload)


if __name__ == "__main__":
    unittest.main()
