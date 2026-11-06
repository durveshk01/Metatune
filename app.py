import base64
import re
import time
import shutil
import tempfile
import urllib.error
import urllib.request
import urllib.parse
import random
import unicodedata
import zipfile
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlparse

from pydantic import BaseModel
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Response
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from mutagen.id3 import (
    APIC, COMM, ID3, TALB, TCON, TCOM, TCOP, TDRC, TKEY, TLAN, TIT2, TPE1,
    TPE2, TPUB, TRCK, TPOS, TBPM, TXXX, USLT,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
ALLOWED_AUDIO_TYPES = {".mp3", ".m4a"}
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png"}
MAX_AUDIO_SIZE = 50 * 1024 * 1024
MAX_COVER_SIZE = 10 * 1024 * 1024
MAX_MULTIPART_REQUEST_SIZE = MAX_AUDIO_SIZE + MAX_COVER_SIZE + 2 * 1024 * 1024
MAX_PROMPT_LENGTH = 1000
MAX_LYRICS_LENGTH = 100_000
CHUNK_SIZE = 1024 * 1024
# How long a processed file stays available for download before it is swept.
OUTPUT_TTL_SECONDS = 60 * 60
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Audio Metadata Generator")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if (request.url.path in {"/generate", "/api/read-metadata"}
            and content_length and content_length.isdigit()
            and int(content_length) > MAX_MULTIPART_REQUEST_SIZE):
        response = JSONResponse(
            status_code=413,
            content={"detail": "Upload is too large. Audio and artwork limits are 50 MB and 10 MB."},
        )
    else:
        response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
        "form-action 'self'; script-src 'self' https://unpkg.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob: https://image.pollinations.ai; "
        "media-src 'self' blob:; connect-src 'self' https://image.pollinations.ai"
    )
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

class GenerateRequest(BaseModel):
    prompt: str
    style: str = ""
    mood: str = ""
    color: str = ""
    aspect: str = "square"


class ExportZipRequest(BaseModel):
    job_ids: list[str]


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request},
    )

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/read-metadata")
async def read_metadata(audio_file: UploadFile = File(...)):
    """Extract embedded tags and technical properties without retaining the source file."""
    suffix = Path(audio_file.filename or "").suffix.lower()
    if suffix not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=400, detail="Only MP3 and M4A files are supported.")

    with tempfile.TemporaryDirectory(prefix="metatune-read-") as temp_dir:
        source_path = Path(temp_dir) / f"source{suffix}"
        size = await save_upload(audio_file, source_path, MAX_AUDIO_SIZE, "Audio file")
        if not size:
            raise HTTPException(status_code=400, detail="Audio file is empty.")
        try:
            audio, values, artwork = extract_audio_metadata(source_path, suffix)
            info = audio.info
            duration = float(getattr(info, "length", 0) or 0)
            return {
                "metadata": values,
                "artwork": artwork,
                "technical": {
                    "format": suffix[1:].upper(),
                    "size": size,
                    "duration": duration,
                    "bitrate": getattr(info, "bitrate", None),
                    "sample_rate": getattr(info, "sample_rate", None),
                    "channels": getattr(info, "channels", None),
                    "codec": "MPEG Layer III" if suffix == ".mp3" else "MPEG-4 Audio",
                },
            }
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail="Could not read metadata. Check that this is a valid MP3 or M4A file.",
            ) from exc

@app.post("/api/generate-cover")
async def generate_cover(req: GenerateRequest):
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    if len(prompt) > MAX_PROMPT_LENGTH:
        raise HTTPException(status_code=400, detail=f"Prompt must be {MAX_PROMPT_LENGTH} characters or fewer.")
    styles = {"Minimal", "Hip-Hop", "Electronic", "Cyberpunk", "Lo-Fi", "Retro", "Rock", "Pop", "Cinematic", "Classical", "Abstract", "Anime"}
    moods = {"Dark", "Energetic", "Chill", "Emotional", "Happy", "Aggressive", "Mysterious"}
    if req.style and req.style not in styles:
        raise HTTPException(status_code=400, detail="Choose a listed artwork style.")
    if req.mood and req.mood not in moods:
        raise HTTPException(status_code=400, detail="Choose a listed artwork mood.")
    if len(req.color) > 120:
        raise HTTPException(status_code=400, detail="Color preference must be 120 characters or fewer.")
    dimensions = {"square": (1024, 1024), "portrait": (1024, 1280), "landscape": (1280, 720)}
    if req.aspect not in dimensions:
        raise HTTPException(status_code=400, detail="Choose square, portrait, or landscape artwork.")
    descriptors = [prompt]
    if req.style:
        descriptors.append(f"{req.style} visual style")
    if req.mood:
        descriptors.append(f"{req.mood.lower()} mood")
    if req.color.strip():
        descriptors.append(f"color palette: {req.color.strip()}")
    descriptors.append("original music cover art, no logos or watermarks")
    safe_prompt = urllib.parse.quote(", ".join(descriptors))
    width, height = dimensions[req.aspect]
    images = []
    # Generate 4 variations using different seeds
    for _ in range(4):
        seed = random.randint(1, 999999)
        images.append(f"https://image.pollinations.ai/prompt/{safe_prompt}?width={width}&height={height}&nologo=true&seed={seed}")
    return {"images": images}

@app.get("/api/proxy-image")
def proxy_image(url: str):
    if len(url) > 4096:
        raise HTTPException(status_code=400, detail="Invalid URL")
    parsed_url = urlparse(url)
    if (parsed_url.scheme != "https" or parsed_url.hostname != "image.pollinations.ai"
            or parsed_url.port not in (None, 443) or parsed_url.username or parsed_url.password):
        raise HTTPException(status_code=400, detail="Invalid URL")

    class SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, file, code, message, headers, new_url):
            target = urlparse(new_url)
            if (target.scheme != "https" or target.hostname != "image.pollinations.ai"
                    or target.port not in (None, 443) or target.username or target.password):
                return None
            return super().redirect_request(request, file, code, message, headers, new_url)

    try:
        image_request = urllib.request.Request(url, headers={"User-Agent": "Metatune/1.0"})
        opener = urllib.request.build_opener(SameHostRedirectHandler())
        with opener.open(image_request, timeout=15) as response:
            if response.status != 200:
                raise HTTPException(status_code=502, detail="Image provider returned an error.")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_COVER_SIZE:
                raise HTTPException(status_code=413, detail="Generated artwork is too large.")
            img_data = response.read(MAX_COVER_SIZE + 1)
        if len(img_data) > MAX_COVER_SIZE:
            raise HTTPException(status_code=413, detail="Generated artwork is too large.")
        image_mime = detect_image_mime(img_data)
        if image_mime is None:
            raise HTTPException(status_code=502, detail="Image provider returned an invalid image.")
        return Response(content=img_data, media_type=image_mime, headers={"X-Content-Type-Options": "nosniff"})
    except HTTPException:
        raise
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise HTTPException(status_code=502, detail="Could not fetch generated artwork.") from exc

@app.post("/generate")
async def generate_metadata(
    audio_file: UploadFile = File(...),
    cover_image: UploadFile | None = File(None),
    title: str = Form(...),
    artist: str = Form(...),
    album: str = Form(...),
    genre: str = Form(...),
    year: str = Form(...),
    album_artist: str = Form(""),
    composer: str = Form(""),
    track: str = Form(""),
    disc: str = Form(""),
    release_date: str = Form(""),
    publisher: str = Form(""),
    copyright: str = Form(""),
    isrc: str = Form(""),
    bpm: str = Form(""),
    key: str = Form(""),
    language: str = Form(""),
    lyrics: str = Form(""),
    comments: str = Form(""),
    remove_artwork: bool = Form(False),
    clean_filename: bool = Form(True),
    output_filename: str = Form(""),
):
    metadata = clean_metadata({
        "title": title,
        "artist": artist,
        "album": album,
        "genre": genre,
        "year": year,
        "album_artist": album_artist,
        "composer": composer,
        "track": track,
        "disc": disc,
        "release_date": release_date,
        "publisher": publisher,
        "copyright": copyright,
        "isrc": isrc,
        "bpm": bpm,
        "key": key,
        "language": language,
        "lyrics": lyrics,
        "comments": comments,
    })

    audio_suffix = Path(audio_file.filename or "").suffix.lower()
    if audio_suffix not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=400, detail="Only MP3 and M4A files are supported.")

    if cover_image and cover_image.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Album cover must be a JPG or PNG image.")
    if remove_artwork and cover_image:
        raise HTTPException(status_code=400, detail="Choose new artwork or remove artwork, not both.")

    # Remove stale processed files so the outputs folder does not grow unbounded.
    sweep_outputs()

    job_id = uuid4().hex
    input_path = UPLOAD_DIR / f"{job_id}{audio_suffix}"
    if clean_filename:
        requested_stem = output_filename.strip() or f"{metadata['artist']} - {metadata['title']}"
    else:
        requested_stem = Path((audio_file.filename or "tagged").replace("\\", "/")).name
    safe_stem = safe_filename_stem(requested_stem)
    download_name = f"{safe_stem}_tagged{audio_suffix}"
    output_path = OUTPUT_DIR / f"{job_id}_{download_name}"

    try:
        audio_size = await save_upload(audio_file, input_path, MAX_AUDIO_SIZE, "Audio file")
        if audio_size == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty.")

        cover_data = None
        cover_mime = None
        if cover_image:
            cover_data = await read_upload(cover_image, MAX_COVER_SIZE, "Album cover")
            cover_mime = detect_image_mime(cover_data)
            if cover_mime is None or cover_mime != cover_image.content_type:
                raise HTTPException(status_code=400, detail="Album cover must be a valid JPG or PNG image.")

        await run_in_threadpool(
            process_audio_file, input_path, output_path, audio_suffix,
            cover_data, cover_mime, metadata, remove_artwork,
        )
    except Exception as exc:
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(
            status_code=400,
            detail="Could not write metadata. Check that the audio file is valid and try again.",
        ) from exc

    input_path.unlink(missing_ok=True)

    # Return a handle instead of the bytes. The browser downloads the file from
    # /download/{job_id}, which streams it with Content-Disposition: attachment.
    # A direct server download works on every browser (including iOS Safari) and
    # avoids the blob-URL downloads that silently fail on many mobile browsers.
    return {
        "job_id": job_id,
        "filename": download_name,
        "size": output_path.stat().st_size,
        "download_url": f"/download/{job_id}",
    }


@app.get("/download/{job_id}")
def download_file(job_id: str):
    output_path = resolve_output(job_id)
    if output_path is None:
        raise HTTPException(status_code=404, detail="File not found or has expired. Please process it again.")
    download_name = output_path.name.split("_", 1)[1] if "_" in output_path.name else output_path.name
    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/octet-stream",
    )


@app.post("/api/export-zip")
async def export_zip(request: ExportZipRequest):
    if not request.job_ids or len(request.job_ids) > 50:
        raise HTTPException(status_code=400, detail="Select between 1 and 50 processed files.")
    if len(set(request.job_ids)) != len(request.job_ids):
        raise HTTPException(status_code=400, detail="The export contains duplicate file IDs.")
    files = []
    total_size = 0
    for job_id in request.job_ids:
        path = resolve_output(job_id)
        if path is None:
            raise HTTPException(status_code=404, detail="A processed file has expired. Process it again before exporting.")
        total_size += path.stat().st_size
        files.append((path, path.name.split("_", 1)[1]))
    if total_size > 150 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="ZIP exports are limited to 150 MB total.")

    bundle_id = uuid4().hex
    bundle_path = OUTPUT_DIR / f"{bundle_id}_MetaTune_Export.zip"
    try:
        await run_in_threadpool(create_zip_bundle, files, bundle_path)
    except OSError as exc:
        bundle_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not prepare the ZIP export. Try fewer or smaller files.") from exc
    return {
        "job_id": bundle_id,
        "filename": "MetaTune_Export.zip",
        "size": bundle_path.stat().st_size,
        "download_url": f"/download/{bundle_id}",
    }


def create_zip_bundle(files: list[tuple[Path, str]], destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for path, archive_name in files:
            archive.write(path, arcname=archive_name)



async def save_upload(upload: UploadFile, destination: Path, max_bytes: int, label: str) -> int:
    total = 0
    with destination.open("wb") as target:
        while chunk := await upload.read(CHUNK_SIZE):
            total += len(chunk)
            if total > max_bytes:
                target.close()
                destination.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"{label} is too large.")
            target.write(chunk)
    return total


async def read_upload(upload: UploadFile, max_bytes: int, label: str) -> bytes:
    chunks = []
    total = 0
    while chunk := await upload.read(CHUNK_SIZE):
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=f"{label} is too large.")
        chunks.append(chunk)

    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail=f"{label} is empty.")
    return data


def detect_image_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    return None


def process_audio_file(
    input_path: Path,
    output_path: Path,
    audio_suffix: str,
    cover_data: bytes | None,
    cover_mime: str | None,
    metadata: dict[str, str],
    remove_artwork: bool = False,
) -> None:
    """Copy and tag off the event loop without holding a second full audio copy in memory."""
    shutil.copyfile(input_path, output_path)
    writer = write_mp3_tags if audio_suffix == ".mp3" else write_m4a_tags
    writer(output_path, cover_data, cover_mime, metadata, remove_artwork)


def clean_metadata(values: dict[str, str]) -> dict[str, str]:
    cleaned = {key: clean_text(value, key.replace("_", " ").title()) for key, value in values.items()}
    cleaned["year"] = clean_year_value(cleaned["year"])
    if cleaned["release_date"]:
        try:
            from datetime import date
            date.fromisoformat(cleaned["release_date"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Release date must be a valid date.") from exc
    for label in ("track", "disc"):
        if cleaned[label] and not re.fullmatch(r"\d{1,4}(?:/\d{1,4})?", cleaned[label]):
            raise HTTPException(status_code=400, detail=f"{label.title()} number must look like 1 or 1/12.")
    if cleaned["bpm"]:
        if not cleaned["bpm"].isdigit() or not 1 <= int(cleaned["bpm"]) <= 999:
            raise HTTPException(status_code=400, detail="BPM must be a number from 1 to 999.")
    if len(cleaned["lyrics"]) > MAX_LYRICS_LENGTH:
        raise HTTPException(status_code=400, detail="Lyrics must be 100000 characters or fewer.")
    if len(cleaned["comments"]) > 5000:
        raise HTTPException(status_code=400, detail="Comments must be 5000 characters or fewer.")
    return cleaned


def clean_text(value: str, label: str) -> str:
    cleaned = value.strip()
    max_length = MAX_LYRICS_LENGTH if label == "Lyrics" else (5000 if label == "Comments" else 200)
    if len(cleaned) > max_length:
        raise HTTPException(status_code=400, detail=f"{label} must be {max_length} characters or fewer.")
    return cleaned


def clean_year_value(value: str) -> str:
    cleaned = value.strip()
    if cleaned and not re.fullmatch(r"\d{1,4}", cleaned):
        raise HTTPException(status_code=400, detail="Year must be a 1 to 4 digit number.")
    return cleaned


def safe_filename_stem(filename: str) -> str:
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem = Path(filename).stem.strip() or "tagged"
    stem = re.sub(r"(?:_tagged)+$", "", stem, flags=re.IGNORECASE)
    stem = unicodedata.normalize("NFKC", stem)
    safe_stem = "".join(
        char if unicodedata.category(char)[0] in {"L", "N"} or char in "._-" else "_"
        for char in stem
    )
    safe_stem = re.sub(r"[_-]{2,}", "_", safe_stem).strip("._-") or "tagged"
    if re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])", safe_stem):
        safe_stem = f"_{safe_stem}"
    return safe_stem[:120].rstrip("._-") or "tagged"


def sweep_outputs(ttl_seconds: int = OUTPUT_TTL_SECONDS) -> None:
    """Delete processed files older than the TTL so outputs don't accumulate.

    Only files that follow the job-output naming scheme ({job_id}_name) are
    considered, so placeholders like .gitkeep are never removed.
    """
    now = time.time()
    for path in OUTPUT_DIR.glob("*_*"):
        if not JOB_ID_RE.match(path.name.split("_", 1)[0]):
            continue
        try:
            if path.is_file() and now - path.stat().st_mtime > ttl_seconds:
                path.unlink(missing_ok=True)
        except OSError:
            pass


def resolve_output(job_id: str) -> Path | None:
    """Return the processed file for a job id, guarding against path traversal."""
    if not JOB_ID_RE.match(job_id):
        return None
    matches = sorted(OUTPUT_DIR.glob(f"{job_id}_*"))
    for path in matches:
        if path.is_file():
            try:
                if time.time() - path.stat().st_mtime > OUTPUT_TTL_SECONDS:
                    path.unlink(missing_ok=True)
                    return None
            except OSError:
                return None
            return path
    return None


def extract_audio_metadata(file_path: Path, suffix: str):
    if suffix == ".mp3":
        audio = MP3(file_path, ID3=ID3)
        tags = audio.tags or {}
        read = lambda frame: _id3_value(tags, frame)
        values = {
            "title": read("TIT2"), "artist": read("TPE1"), "album": read("TALB"),
            "album_artist": read("TPE2"), "composer": read("TCOM"), "track": read("TRCK"),
            "disc": read("TPOS"), "genre": read("TCON"), "year": read("TDRC")[:4],
            "release_date": read("TDRC") if len(read("TDRC")) >= 10 else "",
            "publisher": read("TPUB"), "copyright": read("TCOP"), "bpm": read("TBPM"),
            "key": read("TKEY"), "language": read("TLAN"), "lyrics": read("USLT"),
            "comments": read("COMM"),
        }
        values["isrc"] = next(
            (str(frame.text[0]) for frame in tags.getall("TXXX")
             if frame.desc.casefold() == "isrc" and frame.text),
            "",
        ) if hasattr(tags, "getall") else ""
        pictures = tags.getall("APIC") if hasattr(tags, "getall") else []
        picture = next((p for p in pictures if p.type == 3), pictures[0] if pictures else None)
    else:
        audio = MP4(file_path)
        tags = audio.tags or {}
        values = {
            "title": _mp4_value(tags, "\xa9nam"), "artist": _mp4_value(tags, "\xa9ART"),
            "album": _mp4_value(tags, "\xa9alb"), "album_artist": _mp4_value(tags, "aART"),
            "composer": _mp4_value(tags, "\xa9wrt"), "track": _mp4_pair(tags.get("trkn")),
            "disc": _mp4_pair(tags.get("disk")), "genre": _mp4_value(tags, "\xa9gen"),
            "year": _mp4_value(tags, "\xa9day")[:4],
            "release_date": _mp4_value(tags, "\xa9day") if len(_mp4_value(tags, "\xa9day")) >= 10 else "",
            "publisher": _mp4_freeform(tags, "LABEL"), "copyright": _mp4_value(tags, "cprt"),
            "isrc": _mp4_freeform(tags, "ISRC"), "bpm": _mp4_value(tags, "tmpo"),
            "key": _mp4_freeform(tags, "KEY"), "language": _mp4_freeform(tags, "LANGUAGE"),
            "lyrics": _mp4_value(tags, "\xa9lyr"), "comments": _mp4_value(tags, "\xa9cmt"),
        }
        covers = tags.get("covr", [])
        picture = covers[0] if covers else None

    artwork = None
    if picture is not None:
        image_data = bytes(picture.data if hasattr(picture, "data") else picture)
        mime = detect_image_mime(image_data)
        if mime and len(image_data) <= MAX_COVER_SIZE:
            artwork = f"data:{mime};base64,{base64.b64encode(image_data).decode('ascii')}"
    return audio, values, artwork


def _id3_value(tags, frame_id: str) -> str:
    frame = tags.get(frame_id)
    if not frame:
        return ""
    value = getattr(frame, "text", "")
    if isinstance(value, list):
        value = value[0] if value else ""
    return str(value).strip()


def _mp4_value(tags, key: str) -> str:
    values = tags.get(key, [])
    if not values:
        return ""
    value = values[0]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip("\x00")
    return str(value).strip()


def _mp4_freeform(tags, name: str) -> str:
    return _mp4_value(tags, f"----:com.apple.iTunes:{name}")


def _mp4_pair(values) -> str:
    if not values:
        return ""
    number, total = values[0]
    return f"{number}/{total}" if total else str(number)


def _set_id3_text(tags, frame_id: str, frame_type, value: str) -> None:
    if value:
        tags.delall(frame_id)
        tags.add(frame_type(encoding=3, text=value))


def write_mp3_tags(
    file_path: Path,
    cover_data: bytes | None,
    cover_mime: str | None,
    metadata: dict[str, str],
    remove_artwork: bool = False,
) -> None:
    audio = MP3(file_path, ID3=ID3)
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags

    for key, frame_id, frame_type in (
        ("title", "TIT2", TIT2), ("artist", "TPE1", TPE1), ("album", "TALB", TALB),
        ("album_artist", "TPE2", TPE2), ("composer", "TCOM", TCOM),
        ("track", "TRCK", TRCK), ("disc", "TPOS", TPOS), ("genre", "TCON", TCON),
        ("release_date", "TDRC", TDRC), ("publisher", "TPUB", TPUB),
        ("copyright", "TCOP", TCOP), ("bpm", "TBPM", TBPM), ("key", "TKEY", TKEY),
        ("language", "TLAN", TLAN),
    ):
        value = metadata.get(key, "")
        if key == "release_date" and not value:
            value = metadata.get("year", "")
        _set_id3_text(tags, frame_id, frame_type, value)

    if metadata.get("isrc"):
        tags.add(TXXX(encoding=3, desc="ISRC", text=metadata["isrc"]))
    if metadata.get("lyrics"):
        tags.delall("USLT")
        tags.add(USLT(encoding=3, lang="eng", desc="", text=metadata["lyrics"]))
    if metadata.get("comments"):
        tags.delall("COMM")
        tags.add(COMM(encoding=3, lang="eng", desc="", text=metadata["comments"]))
    if remove_artwork or cover_data is not None:
        tags.delall("APIC")
    if cover_data is not None and cover_mime:
        tags.add(APIC(encoding=3, mime=cover_mime, type=3, desc="Cover", data=cover_data))
    audio.save(v2_version=3)


def _set_mp4_text(tags, key: str, value: str) -> None:
    if value:
        tags[key] = [value]


def _set_mp4_freeform(tags, name: str, value: str) -> None:
    if value:
        tags[f"----:com.apple.iTunes:{name}"] = [MP4FreeForm(value.encode("utf-8"))]


def _number_pair(value: str):
    if not value:
        return None
    parts = value.split("/", 1)
    return (int(parts[0]), int(parts[1]) if len(parts) == 2 else 0)


def write_m4a_tags(
    file_path: Path,
    cover_data: bytes | None,
    cover_mime: str | None,
    metadata: dict[str, str],
    remove_artwork: bool = False,
) -> None:
    audio = MP4(file_path)
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags
    for key, atom in (
        ("title", "\xa9nam"), ("artist", "\xa9ART"), ("album", "\xa9alb"),
        ("album_artist", "aART"), ("composer", "\xa9wrt"), ("genre", "\xa9gen"),
        ("copyright", "cprt"), ("lyrics", "\xa9lyr"), ("comments", "\xa9cmt"),
    ):
        _set_mp4_text(tags, atom, metadata.get(key, ""))
    _set_mp4_text(tags, "\xa9day", metadata.get("release_date") or metadata.get("year", ""))
    for key, atom in (("track", "trkn"), ("disc", "disk")):
        pair = _number_pair(metadata.get(key, ""))
        if pair is not None:
            tags[atom] = [pair]
    if metadata.get("bpm"):
        tags["tmpo"] = [int(metadata["bpm"])]
    for key, name in (("isrc", "ISRC"), ("key", "KEY"), ("language", "LANGUAGE"),
                      ("publisher", "LABEL")):
        _set_mp4_freeform(tags, name, metadata.get(key, ""))
    if remove_artwork or cover_data is not None:
        tags.pop("covr", None)
    if cover_data is not None and cover_mime:
        image_format = MP4Cover.FORMAT_JPEG if cover_mime == "image/jpeg" else MP4Cover.FORMAT_PNG
        tags["covr"] = [MP4Cover(cover_data, imageformat=image_format)]
    audio.save()
