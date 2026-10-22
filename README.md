# XsignDrive

XsignDrive is a small Node.js upload site that lets users upload `.ipa` packages and get an expiring HTTPS URL to use as `ipaUrl` with the xsigner IPA signing API. It streams file bytes to the existing private Tigris bucket; it does not buffer multi-gigabyte files in RAM or store upload data on the web service's local filesystem.

## Features

- Xsigner visual palette (`#135de8`, `#0b45ba`, `#f5f8fd`) and the supplied site icon for favicon, Apple touch icon, and social preview.
- Drag/drop and file picker, one `.ipa` at a time, with real browser upload progress.
- Server-streamed multipart upload to the existing private Tigris bucket `xsigner` under the `xsigndrive/` prefix.
- Presigned HTTPS GET link suitable for xsigner's `ipaUrl`, default 24-hour expiry.
- Metadata stored under `xsigndrive-meta/` in the same bucket; expired uploaded IPAs are removed by a periodic cleanup sweep.
- 4 GiB default upload size limit, rate limiting, security headers, JSON API errors, and `/healthz` for Render.

## Endpoints

- `GET /` — upload page.
- `GET /healthz` — readiness check (HTTP 200 when Tigris credentials/configuration are present, otherwise 503).
- `GET /api/config` — maximum upload size and link lifetime used by the UI.
- `POST /api/uploads` — multipart form upload, file field must be named `ipa`; only `.ipa` extension is accepted. Returns `ipaUrl`, `fileName`, `fileSize`, and `expiresAt`.

Success response example:

```json
{
  "success": true,
  "ok": true,
  "id": "<upload-id>",
  "fileName": "MyApp.ipa",
  "fileSize": 123456789,
  "fileSizeFormatted": "117.7 MB",
  "uploadedAt": "<ISO timestamp>",
  "expiresAt": "<ISO timestamp>",
  "urlTtlSeconds": 86400,
  "ipaUrl": "https://<presigned-tigris-url>",
  "url": "https://<presigned-tigris-url>"
}
```

Upload failure responses use JSON `{ "success": false, "ok": false, "code": "...", "error": "..." }`. Common status codes are 400 (wrong/missing field or invalid extension), 413 (file too large), 429 (upload rate limit), 502 (Tigris upload/finalization problem), and 503 (storage configuration missing).

The returned link is a bearer URL: anyone who possesses the entire URL can download the IPA until it expires. Do not post private application links publicly. The expiry cleanup runs every 15 minutes by default; link access expires at the signed URL deadline even if deletion waits until the next sweep.

## Deploy to Render

This repository contains `render.yaml` for a Node web service named `xsigndrive`, in the same Ohio region as xsigner, with `/healthz` as the health check. Create a dedicated GitHub repository (recommended name `XsignDrive`), upload this project's contents to the repository root, and import it into Render as a Blueprint using the repository's `render.yaml`.

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the new Render service using the **same Tigris credentials** as xsigner. Do not commit either secret. The nonsecret config is prefilled in `render.yaml`:

```text
AWS_ENDPOINT_URL_S3=https://t3.storage.dev
AWS_REGION=auto
S3_BUCKET=xsigner
MAX_IPA_BYTES=4294967296
IPA_URL_TTL_SECONDS=86400
```

Tigris does not share environment variables between Render services automatically; the two secret values must be entered into the XsignDrive environment too. Because this uses the same bucket, XsignDrive's objects and cleanup metadata are isolated by prefix and do not enumerate or delete xsigner's own prefixes.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `10000` | HTTP port used by Render |
| `AWS_ENDPOINT_URL_S3` | `https://t3.storage.dev` | Tigris S3 endpoint |
| `AWS_REGION` | `auto` | Tigris signing region |
| `S3_BUCKET` | `xsigner` in Render config | Existing Tigris bucket |
| `MAX_IPA_BYTES` | 4 GiB | Maximum accepted IPA size (range capped at 20 GiB in code) |
| `IPA_URL_TTL_SECONDS` | 86400 (24 hours) | Presigned URL expiry (60 seconds to 7 days) |
| `UPLOAD_RATE_LIMIT` | 5 | Upload attempts per IP per window |
| `UPLOAD_RATE_WINDOW_MS` | 900000 | Rate limit window (15 minutes) |
| `PART_SIZE_BYTES` | 32 MiB | Tigris multipart part size |
| `CLEANUP_INTERVAL_MS` | 900000 | Expired IPA cleanup interval (15 minutes) |

## Local checks

```bash
npm install
npm run check
npm start
```

Without Tigris credentials, the page will load locally but the upload route and `/healthz` will report storage not configured.
