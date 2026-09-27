# Phase 2: Uploads and storage

Status: complete (2026-09-27). Presign route with validation caps and magic byte checks shipped; ingest revalidation noted as a follow up on the presign limitation.
Date started: 2026-09-27

## Plan

1. POST /api/uploads/sign issues R2 presigned PUT URLs via the S3 compatible API: 25 MB limit for images, 200 MB for video, key layout ws/{workspaceId}/src/{uuid}.
2. Server side validation on ingest: magic byte check against the claimed content type, 80 MP pixel cap, EXIF strip on the stored source copy, video capped at 60 seconds with frames extracted by ffmpeg (packages/video helpers).
3. source_media rows record r2Key, dimensions, sha256 and later the mask key.
4. When R2 env is absent the route returns a clear 503 setup notice so local dev fails loudly, not mysteriously.

## Acceptance

25 MB image and 60 s video pass; bad files rejected; unit tests cover the validators.
