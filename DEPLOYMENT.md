# Convertly deployment notes

## Architecture

Netlify hosts the static frontend. The backend must run `server.js` and `worker.js` on the **same machine/container/filesystem** because converted media is delivered from temporary disk rather than object storage. The included `combined.js` starts both processes together.

Redis/Valkey is still used for the BullMQ queue and short-lived job metadata. Supabase is used for auth, user accounts, quotas, conversion history and analytics only.

## Media privacy

Converted files are never uploaded to Supabase Storage or Cloudflare R2. They exist temporarily under `EPHEMERAL_OUTPUT_DIR`, are streamed to the requesting browser, and are deleted when the stream closes. A cleanup process removes abandoned files after `DOWNLOAD_TTL_MINUTES`.

This means the service does temporarily hold the bytes while converting/streaming; a true zero-server-byte conversion is not possible with server-side yt-dlp + FFmpeg.

## Environment

Required: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `FRONTEND_ORIGIN`.

Media settings: `EPHEMERAL_OUTPUT_DIR=/tmp/convertly/downloads`, `DOWNLOAD_TTL_MINUTES=30`, `FORCE_COMPATIBLE_MP4=true`.

Do not commit `backend/.env`. Use `backend/.env.example` as the template.
