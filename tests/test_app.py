import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import app


class AppHelperTests(unittest.TestCase):
    def test_safe_filename_removes_existing_tag_suffix_and_limits_length(self):
        self.assertEqual(app.safe_filename_stem("Track_tagged_tagged.mp3"), "Track")
        self.assertLessEqual(len(app.safe_filename_stem("a" * 300 + ".mp3")), 120)
        self.assertEqual(app.safe_filename_stem("../../bad name.mp3"), "bad_name")

    def test_image_mime_is_detected_from_bytes(self):
        self.assertEqual(app.detect_image_mime(b"\xff\xd8\xffdata"), "image/jpeg")
        self.assertEqual(app.detect_image_mime(b"\x89PNG\r\n\x1a\ndata"), "image/png")
        self.assertIsNone(app.detect_image_mime(b"not an image"))

    def test_invalid_year_is_rejected(self):
        with self.assertRaises(HTTPException):
            app.clean_year_value("20x6")

    def test_output_lookup_validates_job_id(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            job_id = "a" * 32
            output = output_dir / f"{job_id}_song.mp3"
            output.touch()
            with patch.object(app, "OUTPUT_DIR", output_dir):
                self.assertEqual(app.resolve_output(job_id), output)
                self.assertIsNone(app.resolve_output("../../secret"))

    def test_expired_output_is_removed_when_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            output = output_dir / f"{'c' * 32}_song.mp3"
            output.touch()
            os.utime(output, (1, 1))
            with patch.object(app, "OUTPUT_DIR", output_dir):
                self.assertIsNone(app.resolve_output("c" * 32))
            self.assertFalse(output.exists())

    def test_sweeper_removes_only_expired_generated_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            placeholder = output_dir / ".gitkeep"
            stale_output = output_dir / f"{'b' * 32}_song.mp3"
            placeholder.touch()
            stale_output.touch()
            old_time = 1
            os.utime(placeholder, (old_time, old_time))
            os.utime(stale_output, (old_time, old_time))
            with patch.object(app, "OUTPUT_DIR", output_dir):
                app.sweep_outputs(ttl_seconds=1)
            self.assertTrue(placeholder.exists())
            self.assertFalse(stale_output.exists())

    def test_image_proxy_rejects_non_provider_hosts(self):
        with self.assertRaises(HTTPException) as error:
            app.proxy_image("https://image.pollinations.ai.evil.example/prompt/test")
        self.assertEqual(error.exception.status_code, 400)

    def test_blank_mp3_fields_preserve_existing_tags(self):
        class Tags:
            def __init__(self):
                self.frames = {"TPE1": ["Existing Artist"], "TIT2": ["Old Title"]}

            def delall(self, frame_id):
                self.frames.pop(frame_id, None)

            def add(self, frame):
                self.frames.setdefault(frame.FrameID, []).append(frame)

        class Audio:
            def __init__(self):
                self.tags = Tags()
                self.saved = False

            def save(self, **kwargs):
                self.saved = True

        fake_audio = Audio()
        with patch.object(app, "MP3", return_value=fake_audio):
            app.write_mp3_tags(Path("unused.mp3"), b"cover", "image/png", "New Title", "", "", "", "")

        self.assertTrue(fake_audio.saved)
        self.assertEqual(fake_audio.tags.frames["TPE1"], ["Existing Artist"])
        self.assertEqual(fake_audio.tags.frames["TIT2"][0].text, ["New Title"])


if __name__ == "__main__":
    unittest.main()
