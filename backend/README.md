# Convertly backend

The backend runs the heavy `yt-dlp` + FFmpeg conversion work. Converted media uses an **ephemeral download → stream → delete** model.

## Media lifecycle

1. `yt-dlp` downloads source media to a temporary job directory.
2. FFmpeg produces the final MP4 (H.264/AAC) or MP3.
3. The finished file is copied to `/tmp/convertly/downloads/<jobId>.<ext>`.
4. The API streams that file directly to the user's browser.
5. When the stream closes, the file is deleted.
6. A cleanup job also deletes abandoned files after `DOWNLOAD_TTL_MINUTES` (default 30).

The converted video is **not uploaded to Supabase Storage, Cloudflare R2, or another permanent object store**. A temporary server-side copy is unavoidable while FFmpeg is processing/streaming; it is not retained after download/TTL.

## Components

- `server.js`: API, auth, quotas, status and streaming downloads.
- `worker.js`: BullMQ worker using `yt-dlp` + FFmpeg.
- `combined.js`: runs API + worker together so both processes share the same ephemeral filesystem.
- `cleanup.js`: removes abandoned temporary downloads.
- Redis/Valkey: job queue and short-lived metadata.

## Required secrets

Supabase is used for authentication, accounts, quotas, history and analytics. Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. No media bucket is required.

## Local testing

Run `docker compose up --build` from the project root, then check `http://localhost:8787/api/health`. The Docker compose file mounts the same temporary media volume for API and worker.

## MP4 compatibility

The worker prefers H.264 video + AAC audio. When needed, FFmpeg normalizes the final MP4 with H.264/AAC and `+faststart`, improving compatibility with Windows Media Player and common browser/device players.

## Safety

Only process content the user owns or is authorized to process. The worker does not bypass DRM, authentication or paywalls.
