import re
import os
import urllib.request
import urllib.parse
import random
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from mutagen.id3 import APIC, ID3, TALB, TCON, TDRC, TIT2, TPE1, ID3NoHeaderError
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
ALLOWED_AUDIO_TYPES = {".mp3", ".m4a"}
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png"}
MAX_AUDIO_SIZE = 50 * 1024 * 1024
MAX_COVER_SIZE = 10 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Audio Metadata Generator")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

class GenerateRequest(BaseModel):
    prompt: str

@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/api/generate-cover")
async def generate_cover(req: GenerateRequest):
    if not req.prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    safe_prompt = urllib.parse.quote(req.prompt)
    images = []
    # Generate 4 variations using different seeds
    for _ in range(4):
        seed = random.randint(1, 999999)
        images.append(f"https://image.pollinations.ai/prompt/{safe_prompt}?width=800&height=800&nologo=true&seed={seed}")
    return {"images": images}

@app.get("/api/proxy-image")
def proxy_image(url: str):
    if not url.startswith("https://image.pollinations.ai/"):
        raise HTTPException(status_code=400, detail="Invalid URL")
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            img_data = response.read()
        return Response(content=img_data, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")

@app.post("/generate")
async def generate_metadata(
    background_tasks: BackgroundTasks,
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

        output_path.write_bytes(input_path.read_bytes())

        if audio_suffix == ".mp3":
            write_mp3_tags(output_path, cover_data, cover_mime, clean_title, clean_artist, clean_album, clean_genre, clean_year)
        else:
            write_m4a_tags(output_path, cover_data, cover_mime, clean_title, clean_artist, clean_album, clean_genre, clean_year)
    except Exception as exc:
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=400, detail=f"Could not write metadata: {exc}") from exc

    input_path.unlink(missing_ok=True)
    background_tasks.add_task(delete_file, output_path)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/octet-stream",
        background=background_tasks,
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


def clean_text(value: str, label: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{label} is required.")
    if len(cleaned) > 200:
        raise HTTPException(status_code=400, detail=f"{label} must be 200 characters or fewer.")
    return cleaned


def clean_year_value(value: str) -> str:
    cleaned = value.strip()
    if not re.fullmatch(r"\d{1,4}", cleaned):
        raise HTTPException(status_code=400, detail="Year must be a 1 to 4 digit number.")
    return cleaned


def safe_filename_stem(filename: str) -> str:
    stem = Path(filename).stem.strip() or "tagged"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._") or "tagged"


def delete_file(path: Path) -> None:
    path.unlink(missing_ok=True)


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
    try:
        audio.add_tags()
    except ID3NoHeaderError:
        audio.tags = ID3()
    except Exception:
        pass

    if audio.tags is None:
        audio.tags = ID3()

    audio.tags.delall("TIT2")
    audio.tags.delall("TPE1")
    audio.tags.delall("TALB")
    audio.tags.delall("TCON")
    audio.tags.delall("TDRC")
    audio.tags.delall("APIC")

    audio.tags.add(TIT2(encoding=3, text=title))
    audio.tags.add(TPE1(encoding=3, text=artist))
    audio.tags.add(TALB(encoding=3, text=album))
    audio.tags.add(TCON(encoding=3, text=genre))
    audio.tags.add(TDRC(encoding=3, text=year))
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
    audio.tags["\xa9nam"] = [title]
    audio.tags["\xa9ART"] = [artist]
    audio.tags["\xa9alb"] = [album]
    audio.tags["\xa9gen"] = [genre]
    audio.tags["\xa9day"] = [year]
    audio.tags["covr"] = [MP4Cover(cover_data, imageformat=image_format)]
    audio.save()
