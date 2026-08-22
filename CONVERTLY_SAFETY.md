# Convertly Safety Controls

This build adds defense-in-depth controls for authorized-use conversion.

- A visible permission confirmation checkbox is required before single or batch conversion.
- The backend rejects conversion requests without `permissionConfirmed: true`.
- The worker rejects queued jobs that lack the same confirmation.
- Main converter URLs must use HTTPS and remain limited to YouTube hosts.
- Existing Terms, Acceptable Use, Privacy, and Copyright/DMCA pages remain in place.
- Existing rate limits, duration limits, active-job limits, and temporary cleanup behavior are preserved.
- The UI does not offer DRM, private-content, paywall, or access-control bypass functionality.

## Important

The checkbox is a user attestation, not a guarantee that a user's intended use is lawful. Platform terms and applicable copyright law still apply.

## Local Docker build

The backend Dockerfile now installs `python3-pip` before installing yt-dlp. This fixes the Debian slim image build step that previously failed during the pip install stage.
