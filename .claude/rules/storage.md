---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Storage Abstraction Rule

All file/object storage must go through `libs/go-common/storage`. No direct calls to S3, filesystem, or any provider-specific SDK in business logic.

## Supported Backends

- **Local** — local filesystem (development, small self-hosted deployments)
- **S3** — AWS S3
- **MinIO** — S3-compatible, self-hosted (uses S3 driver with custom endpoint)
- **Azure Blob Storage** — Azure SA

Active backend is selected via env var:

```
STORAGE_BACKEND=local    # local | s3 | minio | azure
```

## Architecture

```
Handler → Service → storage.Provider → gocloud.dev/blob → Backend
```

## Usage

Initialize once at startup:

```go
store, err := storage.New(ctx)  // reads STORAGE_BACKEND env var
defer store.Close()
```

Upload, download, delete, check existence, and generate pre-signed URLs:

```go
obj, err := store.Upload(ctx, storage.UploadParams{
    Path:        "uploads/photo.jpg",
    Content:     file,
    ContentType: "image/jpeg",
})

reader, err := store.Download(ctx, "uploads/photo.jpg")
defer reader.Close()

err = store.Delete(ctx, "uploads/photo.jpg")

exists, err := store.Exists(ctx, "uploads/photo.jpg")

url, err := store.GetURL(ctx, "uploads/photo.jpg", 15*time.Minute)
```

## Backend Configuration

Each backend has its own env vars:

```
# Local
STORAGE_LOCAL_BASE_PATH=/data/uploads

# S3
STORAGE_S3_BUCKET=my-bucket
STORAGE_S3_REGION=us-east-1

# MinIO
STORAGE_MINIO_ENDPOINT=minio:9000
STORAGE_MINIO_BUCKET=my-bucket
STORAGE_MINIO_USE_SSL=false

# Azure
STORAGE_AZURE_CONTAINER=my-container
```

S3 and MinIO credentials use standard AWS SDK env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). Azure uses `AZURE_STORAGE_ACCOUNT` and `AZURE_STORAGE_KEY`.

## Rules

- No provider-specific SDK calls outside the storage package
- Services only interact with `storage.Provider` — never concrete backends
- All storage operations must accept and propagate `context.Context`
- File paths are validated automatically (no `..` traversal, no leading slash, forward slashes only)
- `GetURL` returns a pre-signed/temporary URL — never expose raw storage credentials
- Upload enforces the size limit while streaming: the provider default (`Config.MaxSize`, 50MB) or `UploadParams.MaxSize` per call. A declared size (`ExpectedSize`) over the limit is refused before reading; a stream is cut off at the first byte past it and the partial write is aborted. Never read a whole upload to check its size
- Backend credentials go to the backend's client (`storage.Config`), never into process environment variables
- Storage backend is initialized once at startup via `storage.NewWithConfig()` from the setup configuration (modules get it as `module.Deps.Storage`) — no runtime switching
- All backends must pass the same test suite to ensure consistent behavior
