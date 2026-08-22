# Convertly — YouTube → MP4

Convertly is a YouTube → MP4 focused frontend with a separate production API/worker architecture.

## Included

- Premium dark/blue UI with YouTube → MP4 as the primary workflow
- Free quality cap: 1080p
- Pro/Admin UI gates for 1440p and 4K
- Supabase Auth integration (email/password + Google OAuth hook)
- Supabase database schema, RLS, Free/Pro/Admin entitlement functions
- Conversion history, referrals and analytics event storage
- SEO landing pages and blog/tutorial hub
- Netlify static frontend configuration
- Netlify `/api/*` proxy to the production API
- BullMQ + Redis/Valkey conversion queue
- Dockerized worker using yt-dlp + FFmpeg
- Private Supabase Storage with short-lived signed download URLs
- Automatic cleanup of expired stored videos
- MP4 compatibility normalization to H.264 + AAC so downloaded files are broadly playable, including Windows Media Player
- Backend rate limiting, daily quotas, active-job caps and admin overview endpoint
- Render Blueprint for API + worker + Key Value + cleanup cron

## Architecture

**Netlify** hosts the static frontend. **Render** runs the heavy Node/FFmpeg API and background worker. **Supabase** handles Auth/database and private video storage. **Render Key Value** provides the Redis-compatible queue store.

Cloudflare is not required.

## Important

The frontend alone does not perform online conversion. The backend/worker must run on a real compute service because yt-dlp/FFmpeg jobs are CPU/RAM intensive. Netlify Functions are not used for the conversion engine.

Only process media that the user owns or is authorized to process. The worker does not implement DRM, authentication, paywall or access-control bypasses.

## Local testing

1. Make sure Docker Desktop is running.
2. Run `docker compose up --build` from the project root.
3. Check `http://localhost:8787/api/health`.
4. Serve the project root with VS Code Live Server on port 5500 (do not use 8787 for Live Server).
5. Open `http://127.0.0.1:5500/` and test the converter.

Local development uses the private Docker volume under `/tmp/convertly` and can run in guest mode without Supabase Storage.

## Production deployment

1. Run the updated `supabase_schema.sql` in Supabase. It creates the private `convertly-files` Storage bucket.
2. Push this project to GitHub.
3. Create a Render Blueprint from `render.yaml`. It creates the API, worker, Key Value queue and cleanup cron.
4. In Render, enter `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the exact Netlify production URL for `FRONTEND_ORIGIN`.
5. Deploy the frontend to Netlify. Keep the Render API service named `convertly-api`, or change the API proxy target in `netlify.toml` to your actual Render URL.
6. Update the canonical/OG/sitemap/robots URLs to your real Netlify domain.
7. Test a 720p/1080p MP4 and verify the downloaded file opens locally before enabling Pro/4K traffic.

See `DEPLOYMENT.md` for the launch checklist.

## Security

- Never commit `backend/.env`.
- Never put `SUPABASE_SERVICE_ROLE_KEY` in frontend files.
- The Storage bucket is private.
- Downloads are returned through short-lived signed URLs.
- Free/Pro/Admin limits are enforced server-side.
