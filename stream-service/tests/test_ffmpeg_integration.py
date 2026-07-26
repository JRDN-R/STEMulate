from __future__ import annotations

import math
import shutil
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from worker import (
    Deadline,
    MediaPipeline,
    SAMPLE_RATE,
    SubprocessRunner,
    ToolPaths,
    build_windows,
    common_duration_frames,
    index_adts_file,
)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "ffmpeg and ffprobe are required",
)
class FfmpegIntegrationTests(unittest.TestCase):
    def _silence(self, path: Path, frames: int, channels: int) -> None:
        with wave.open(str(path), "wb") as output:
            output.setnchannels(channels)
            output.setsampwidth(2)
            output.setframerate(44_100)
            output.writeframes(b"\x00\x00" * channels * frames)

    def test_real_encoder_produces_aligned_contract_adts(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            mono = work / "mono.wav"
            stereo = work / "stereo.wav"
            self._silence(mono, 44_100, 1)
            self._silence(stereo, 46_305, 2)
            tools = ToolPaths(
                ffmpeg=shutil.which("ffmpeg") or "/usr/bin/ffmpeg",
                ffprobe=shutil.which("ffprobe") or "/usr/bin/ffprobe",
            )
            pipeline = MediaPipeline(SubprocessRunner(), tools, bitrate_kbps=96)
            deadline = Deadline(30)
            probes = [
                pipeline.probe(mono, cwd=work, deadline=deadline),
                pipeline.probe(stereo, cwd=work, deadline=deadline),
            ]
            duration_frames = common_duration_frames(probes)
            packet_counts = []
            channels = []
            for source, probe in zip((mono, stereo), probes, strict=True):
                target = work / f"{source.stem}.aac"
                pipeline.encode(
                    source,
                    target,
                    duration_frames=duration_frames,
                    channels=probe.channels,
                    cwd=work,
                    deadline=deadline,
                )
                packets, _ = index_adts_file(target)
                packet_counts.append(len(packets))
                channels.append(packets[0].channels)
                self.assertEqual(packets[0].sample_rate, SAMPLE_RATE)
            self.assertEqual(packet_counts[0], packet_counts[1])
            self.assertEqual(
                packet_counts[0],
                duration_frames // 1_024 + 1,
            )
            self.assertEqual(channels, [1, 2])

    def test_window_preroll_reconstructs_the_continuous_aac_timeline(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            source = work / "tone.wav"
            frames = 11 * 44_100
            with wave.open(str(source), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(44_100)
                payload = bytearray()
                for index in range(frames):
                    sample = int(14_000 * math.sin(2 * math.pi * 440 * index / 44_100))
                    payload.extend(struct.pack("<hh", sample, -sample))
                output.writeframes(payload)

            tools = ToolPaths(
                ffmpeg=shutil.which("ffmpeg") or "/usr/bin/ffmpeg",
                ffprobe=shutil.which("ffprobe") or "/usr/bin/ffprobe",
            )
            pipeline = MediaPipeline(SubprocessRunner(), tools, bitrate_kbps=128)
            deadline = Deadline(30)
            probe = pipeline.probe(source, cwd=work, deadline=deadline)
            duration_frames = common_duration_frames([probe])
            encoded = work / "tone.aac"
            pipeline.encode(
                source,
                encoded,
                duration_frames=duration_frames,
                channels=2,
                cwd=work,
                deadline=deadline,
            )
            packets, _ = index_adts_file(encoded)
            windows = build_windows(packets)
            self.assertGreaterEqual(len(windows), 3)

            full_pcm = work / "full.f32"
            subprocess.run(
                [
                    tools.ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-nostdin",
                    "-y",
                    "-i",
                    str(encoded),
                    "-f",
                    "f32le",
                    "-acodec",
                    "pcm_f32le",
                    str(full_pcm),
                ],
                cwd=work,
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            bytes_per_frame = 2 * 4
            continuous = full_pcm.read_bytes()[
                1_024 * bytes_per_frame:
                (1_024 + duration_frames) * bytes_per_frame
            ]
            reconstructed = bytearray()
            encoded_bytes = encoded.read_bytes()
            for index, window in enumerate(windows):
                fragment = work / f"fragment-{index}.aac"
                fragment.write_bytes(encoded_bytes[
                    window["prerollByteStart"]:
                    window["byteEndExclusive"]
                ])
                decoded = work / f"fragment-{index}.f32"
                subprocess.run(
                    [
                        tools.ffmpeg,
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-nostdin",
                        "-y",
                        "-i",
                        str(fragment),
                        "-f",
                        "f32le",
                        "-acodec",
                        "pcm_f32le",
                        str(decoded),
                    ],
                    cwd=work,
                    check=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                fragment_pcm = decoded.read_bytes()
                start = 1_024 * bytes_per_frame
                end = start + window["frameCount"] * bytes_per_frame
                reconstructed.extend(fragment_pcm[start:end])

            reconstructed_samples = tuple(
                sample[0] for sample in struct.iter_unpack("<f", reconstructed)
            )
            continuous_samples = tuple(
                sample[0] for sample in struct.iter_unpack("<f", continuous)
            )
            self.assertEqual(len(reconstructed_samples), len(continuous_samples))
            errors = [
                abs(actual - expected)
                for actual, expected in zip(
                    reconstructed_samples,
                    continuous_samples,
                    strict=True,
                )
            ]
            self.assertLess(
                max(errors, default=0),
                2e-5,
                "Independent AAC window decoding diverged from continuous decoding.",
            )


if __name__ == "__main__":
    unittest.main()
