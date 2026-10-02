import re
import time
import shutil
import urllib.error
import urllib.request
import urllib.parse
import random
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlparse

from pydantic import BaseModel
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Response
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from mutagen.id3 import APIC, ID3, TALB, TCON, TDRC, TIT2, TPE1
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
ALLOWED_AUDIO_TYPES = {".mp3", ".m4a"}
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png"}
MAX_AUDIO_SIZE = 50 * 1024 * 1024
MAX_COVER_SIZE = 10 * 1024 * 1024
MAX_PROMPT_LENGTH = 1000
CHUNK_SIZE = 1024 * 1024
# How long a processed file stays available for download before it is swept.
OUTPUT_TTL_SECONDS = 60 * 60
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Audio Metadata Generator")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

class GenerateRequest(BaseModel):
    prompt: str

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

@app.post("/api/generate-cover")
async def generate_cover(req: GenerateRequest):
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    if len(prompt) > MAX_PROMPT_LENGTH:
        raise HTTPException(status_code=400, detail=f"Prompt must be {MAX_PROMPT_LENGTH} characters or fewer.")
    safe_prompt = urllib.parse.quote(prompt)
    images = []
    # Generate 4 variations using different seeds
    for _ in range(4):
        seed = random.randint(1, 999999)
        images.append(f"https://image.pollinations.ai/prompt/{safe_prompt}?width=800&height=800&nologo=true&seed={seed}")
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
    cover_image: UploadFile = File(...),
    title: str = Form(...),
    artist: str = Form(...),
    album: str = Form(...),
    genre: str = Form(...),
    year: str = Form(...),
):
    clean_title = clean_text(title, "Title")
    clean_artist = clean_text(artist, "Artist")
    clean_album = clean_text(album, "Album")
    clean_genre = clean_text(genre, "Genre")
    clean_year = clean_year_value(year)

    audio_suffix = Path(audio_file.filename or "").suffix.lower()
    if audio_suffix not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=400, detail="Only MP3 and M4A files are supported.")

    if cover_image.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Album cover must be a JPG or PNG image.")

    # Remove stale processed files so the outputs folder does not grow unbounded.
    sweep_outputs()

    job_id = uuid4().hex
    input_path = UPLOAD_DIR / f"{job_id}{audio_suffix}"
    safe_stem = safe_filename_stem(audio_file.filename or "tagged")
    download_name = f"{safe_stem}_tagged{audio_suffix}"
    output_path = OUTPUT_DIR / f"{job_id}_{download_name}"

    try:
        audio_size = await save_upload(audio_file, input_path, MAX_AUDIO_SIZE, "Audio file")
        if audio_size == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty.")

        cover_data = await read_upload(cover_image, MAX_COVER_SIZE, "Album cover")
        cover_mime = detect_image_mime(cover_data)
        if cover_mime is None or cover_mime != cover_image.content_type:
            raise HTTPException(status_code=400, detail="Album cover must be a valid JPG or PNG image.")

        await run_in_threadpool(
            process_audio_file, input_path, output_path, audio_suffix,
            cover_data, cover_mime, clean_title, clean_artist, clean_album, clean_genre, clean_year,
        )
    except Exception as exc:
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=400, detail=f"Could not write metadata: {exc}") from exc

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
    cover_data: bytes,
    cover_mime: str,
    title: str,
    artist: str,
    album: str,
    genre: str,
    year: str,
) -> None:
    """Copy and tag off the event loop without holding a second full audio copy in memory."""
    shutil.copyfile(input_path, output_path)
    writer = write_mp3_tags if audio_suffix == ".mp3" else write_m4a_tags
    writer(output_path, cover_data, cover_mime, title, artist, album, genre, year)


def clean_text(value: str, label: str) -> str:
    cleaned = value.strip()
    if len(cleaned) > 200:
        raise HTTPException(status_code=400, detail=f"{label} must be 200 characters or fewer.")
    return cleaned


def clean_year_value(value: str) -> str:
    cleaned = value.strip()
    if cleaned and not re.fullmatch(r"\d{1,4}", cleaned):
        raise HTTPException(status_code=400, detail="Year must be a 1 to 4 digit number.")
    return cleaned


def safe_filename_stem(filename: str) -> str:
    stem = Path(filename).stem.strip() or "tagged"
    stem = re.sub(r"(?:_tagged)+$", "", stem, flags=re.IGNORECASE)
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._") or "tagged"
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


def write_mp3_tags(
    file_path: Path,
    cover_data: bytes,
    cover_mime: str,
    title: str,
    artist: str,
    album: str,
    genre: str,
    year: str,
) -> None:
    audio = MP3(file_path, ID3=ID3)
    if audio.tags is None:
        audio.add_tags()

    if title:
        audio.tags.delall("TIT2")
        audio.tags.add(TIT2(encoding=3, text=title))
    if artist:
        audio.tags.delall("TPE1")
        audio.tags.add(TPE1(encoding=3, text=artist))
    if album:
        audio.tags.delall("TALB")
        audio.tags.add(TALB(encoding=3, text=album))
    if genre:
        audio.tags.delall("TCON")
        audio.tags.add(TCON(encoding=3, text=genre))
    if year:
        audio.tags.delall("TDRC")
        audio.tags.add(TDRC(encoding=3, text=year))
    audio.tags.delall("APIC")
    audio.tags.add(
        APIC(
            encoding=3,
            mime=cover_mime,
            type=3,
            desc="Cover",
            data=cover_data,
        )
    )
    audio.save(v2_version=3)


def write_m4a_tags(
    file_path: Path,
    cover_data: bytes,
    cover_mime: str,
    title: str,
    artist: str,
    album: str,
    genre: str,
    year: str,
) -> None:
    audio = MP4(file_path)
    if audio.tags is None:
        audio.add_tags()

    image_format = MP4Cover.FORMAT_JPEG if cover_mime == "image/jpeg" else MP4Cover.FORMAT_PNG
    if title:
        audio.tags["\xa9nam"] = [title]
    if artist:
        audio.tags["\xa9ART"] = [artist]
    if album:
        audio.tags["\xa9alb"] = [album]
    if genre:
        audio.tags["\xa9gen"] = [genre]
    if year:
        audio.tags["\xa9day"] = [year]
    audio.tags["covr"] = [MP4Cover(cover_data, imageformat=image_format)]
    audio.save()
