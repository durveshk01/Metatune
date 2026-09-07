# Audio Metadata Generator Deployment

This project is a simple FastAPI app for adding metadata and album artwork to MP3 and M4A files. It uses Mutagen only. There is no database, authentication, Redis, Docker, OpenAI, Whisper, Supabase, Celery, or external metadata service.

## Project Structure

```text
project/
├── app.py
├── static/
│   ├── script.js
│   └── style.css
├── templates/
│   └── index.html
├── uploads/
│   └── .gitkeep
├── outputs/
│   └── .gitkeep
├── requirements.txt
├── render.yaml
├── Procfile
├── runtime.txt
└── DEPLOYMENT.md
```

## Local Setup

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

Open:

```text
http://127.0.0.1:8000
```

## GitHub Setup

1. Go to [GitHub](https://github.com/new).
2. Create a new repository.
3. Do not add a README, license, or `.gitignore` from GitHub if this local project already has files.
4. Copy the repository URL.

From the project folder:

```bash
git init
git add .
git commit -m "Deploy metadata generator"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

If the remote already exists, use:

```bash
git remote set-url origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

## Render Deployment

1. Go to [Render](https://render.com).
2. Click **New**.
3. Choose **Web Service**.
4. Connect your GitHub account.
5. Select the GitHub repository for this project.
6. Use these settings:

```text
Environment: Python
Build Command: pip install -r requirements.txt
Start Command: uvicorn app:app --host 0.0.0.0 --port $PORT
Plan: Free
```

7. Click **Create Web Service**.
8. Wait for the build and deploy to finish.
9. Open the live Render URL shown in the service dashboard.

The included `render.yaml` also defines the same Render settings and a `/health` health check.

## How To Use The Live App

1. Open the Render live URL.
2. Upload an MP3 or M4A file.
3. Enter Title, Artist, Album, Genre, and Year.
4. Upload a JPG or PNG album cover.
5. Click **Generate Metadata**.
6. The tagged file downloads automatically.

## Production Limits

- Audio files are limited to 50 MB.
- Cover images are limited to 10 MB.
- Audio formats are limited to `.mp3` and `.m4a`.
- Cover images are limited to valid JPEG and PNG files.
- Uploaded and generated files are temporary and cleaned up after processing/download.

## Required Environment Variables

None.

Render provides `PORT` automatically.

## Notes For Render Free Tier

- Free services may sleep after inactivity.
- The first request after sleeping can be slower.
- Render disk is ephemeral, so this app intentionally treats uploads and outputs as temporary files.
- Very large uploads are rejected to keep memory and disk usage reasonable.
