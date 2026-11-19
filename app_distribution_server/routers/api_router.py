import datetime
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, Query, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field

from app_distribution_server.build_info import (
    BuildInfo,
    Platform,
    get_build_info,
)
from app_distribution_server.config import (
    MAX_UPLOAD_SIZE_BYTES,
    MAX_UPLOAD_SIZE_MB,
    UPLOADS_SECRET_AUTH_TOKEN,
    get_absolute_url,
)
from app_distribution_server.errors import (
    InvalidFileTypeError,
    NotFoundError,
    UnauthorizedError,
)
from app_distribution_server.logger import logger
from app_distribution_server.storage import (
    add_tag,
    delete_upload,
    get_all_tags,
    get_latest_upload_id_by_bundle_id,
    get_upload_asserted_platform,
    list_all_uploaded_files,
    load_build_info,
    load_upload_tags,
    save_upload,
    tag_exists,
)
from app_distribution_server.storage import (
    update_tag as storage_update_tag,
)
from app_distribution_server.validation import (
    BUNDLE_ID_PATTERN,
    MAX_TAGS_PER_UPLOAD,
    TAG_MAX_LENGTH,
    UploadIdPath,
    validate_tag,
)

x_auth_token_dependency = APIKeyHeader(name="X-Auth-Token", auto_error=False)

_EXPECTED_TOKEN_BYTES = UPLOADS_SECRET_AUTH_TOKEN.encode("utf-8")


def x_auth_token_validator(
    x_auth_token: str | None = Depends(x_auth_token_dependency),
):
    if not x_auth_token:
        raise UnauthorizedError()

    # Compare bytes: compare_digest raises on non-ASCII str input.
    if not secrets.compare_digest(x_auth_token.encode("utf-8"), _EXPECTED_TOKEN_BYTES):
        raise UnauthorizedError()


requires_auth = [Depends(x_auth_token_validator)]

router = APIRouter(
    tags=["API"],
)

_UPLOAD_CHUNK_SIZE = 1024 * 1024


def _read_upload_with_limit(app_file: UploadFile) -> bytes:
    buffer = bytearray()
    while chunk := app_file.file.read(_UPLOAD_CHUNK_SIZE):
        buffer.extend(chunk)
        if len(buffer) > MAX_UPLOAD_SIZE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum upload size is {MAX_UPLOAD_SIZE_MB}MB.",
            )
    return bytes(buffer)


def _validate_upload_tags(tags: list[str] | None) -> list[str]:
    if not tags:
        return []

    cleaned = sorted({t.strip() for t in tags if t and t.strip()})
    if len(cleaned) > MAX_TAGS_PER_UPLOAD:
        raise HTTPException(
            status_code=400,
            detail=f"Too many tags. At most {MAX_TAGS_PER_UPLOAD} tags per upload.",
        )

    known_tags = set(get_all_tags())
    unknown = [t for t in cleaned if t not in known_tags]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown tags: {', '.join(unknown)}. Create them first.",
        )
    return cleaned


def _upload_app(
    app_file: UploadFile,
    tags: list[str] | None = None,
) -> BuildInfo:
    platform: Platform

    filename = (app_file.filename or "").lower()
    if filename.endswith(".ipa"):
        platform = Platform.ios
    elif filename.endswith(".apk"):
        platform = Platform.android
    else:
        raise InvalidFileTypeError()

    app_file_content = _read_upload_with_limit(app_file)
    build_info = get_build_info(platform, app_file_content)
    upload_id = build_info.upload_id

    logger.debug(f"Starting upload of {upload_id!r}")

    build_info.tags = tags or []

    save_upload(build_info, app_file_content, build_info.tags)
    logger.info(f"Successfully uploaded {build_info.bundle_id!r} ({upload_id!r})")

    return build_info


_upload_route_kwargs = {
    "responses": {
        InvalidFileTypeError.STATUS_CODE: {
            "description": InvalidFileTypeError.ERROR_MESSAGE,
        },
        UnauthorizedError.STATUS_CODE: {
            "description": UnauthorizedError.ERROR_MESSAGE,
        },
        413: {"description": "File too large"},
    },
    "summary": "Upload an iOS/Android app Build",
    "description": "On swagger UI authenticate in the upper right corner ('Authorize' button).",
    "dependencies": requires_auth,
}

_TagsForm = Annotated[
    list[str] | None,
    Form(description="Optional list of existing tags to associate with this upload"),
]
_AppFile = Annotated[UploadFile, File(description="An `.ipa` or `.apk` build")]


@router.post("/upload", **_upload_route_kwargs)
def _plaintext_post_upload(app_file: _AppFile, tags: _TagsForm = None) -> PlainTextResponse:
    build_info = _upload_app(app_file, _validate_upload_tags(tags))
    return PlainTextResponse(
        content=get_absolute_url(f"/get/{build_info.upload_id}"),
    )


@router.post("/api/upload", **_upload_route_kwargs)
def _json_api_post_upload(app_file: _AppFile, tags: _TagsForm = None) -> BuildInfo:
    return _upload_app(app_file, _validate_upload_tags(tags))


async def _api_delete_app_upload(upload_id: UploadIdPath) -> PlainTextResponse:
    get_upload_asserted_platform(upload_id)

    delete_upload(upload_id)
    logger.info(f"Upload {upload_id!r} deleted successfully")

    return PlainTextResponse(status_code=200, content="Upload deleted successfully")


router.delete(
    "/api/delete/{upload_id}",
    summary="Delete an uploaded app build",
    response_class=PlainTextResponse,
    dependencies=requires_auth,
)(_api_delete_app_upload)

router.delete(
    "/delete/{upload_id}",
    deprecated=True,
    summary="Delete an uploaded app build. Deprecated, use /api/delete/UPLOAD_ID instead",
    response_class=PlainTextResponse,
    dependencies=requires_auth,
)(_api_delete_app_upload)


@router.get(
    "/api/bundle/{bundle_id}/latest_upload",
    summary="Retrieve the latest upload from a bundle ID",
)
def api_get_latest_upload_by_bundle_id(
    bundle_id: str = Path(pattern=BUNDLE_ID_PATTERN),
) -> BuildInfo:
    upload_id = get_latest_upload_id_by_bundle_id(bundle_id)

    if not upload_id:
        raise NotFoundError()

    get_upload_asserted_platform(upload_id)
    return load_build_info(upload_id)


def _created_at_sort_key(build_info: BuildInfo) -> datetime.datetime:
    created_at = build_info.created_at
    if created_at is None:
        return datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
    if created_at.tzinfo is None:
        return created_at.replace(tzinfo=datetime.timezone.utc)
    return created_at


class UploadListItem(BaseModel):
    upload_id: str
    file_name: str
    url: str
    build_info: BuildInfo
    tags: list[str]


@router.get(
    "/api/uploads",
    summary="List all uploaded files with their URLs, optionally filtered by platform and tags",
    dependencies=requires_auth,
)
def api_list_all_uploaded_files(
    platform: Platform | None = Query(default=None, description="Filter by platform"),
    tags: list[str] | None = Query(default=None, description="Filter by tags (all must match)"),
) -> list[UploadListItem]:
    tags_filter = {t.strip() for t in tags if t.strip()} if tags else set()
    builds: list[BuildInfo] = []

    for upload_id in list_all_uploaded_files():
        try:
            platform_on_disk = get_upload_asserted_platform(upload_id)
            build_info = load_build_info(upload_id)
        except Exception:
            # Skip uploads that are incomplete or cannot be read.
            logger.warning(f"Skipping unreadable upload {upload_id!r}", exc_info=True)
            continue

        if platform and platform_on_disk != platform:
            continue
        if tags_filter and not tags_filter.issubset(set(build_info.tags)):
            continue
        builds.append(build_info)

    builds.sort(key=_created_at_sort_key, reverse=True)

    return [
        UploadListItem(
            upload_id=b.upload_id,
            file_name=b.platform.app_file_name,
            url=get_absolute_url(f"/get/{b.upload_id}"),
            build_info=b,
            tags=list(b.tags),
        )
        for b in builds
    ]


class TagCreateRequest(BaseModel):
    tag: str = Field(max_length=TAG_MAX_LENGTH * 2)


@router.post(
    "/api/tags",
    summary="Create a new tag (unique string)",
    dependencies=requires_auth,
)
def create_tag(request: TagCreateRequest):
    tag = validate_tag(request.tag)
    if not add_tag(tag):
        raise HTTPException(status_code=409, detail="Tag already exists")
    return {"tag": tag}


@router.get(
    "/api/tags",
    summary="Get all tags",
    dependencies=requires_auth,
)
def get_tags():
    return {"tags": get_all_tags()}


@router.get(
    "/api/tags/{tag}",
    summary="Get a single tag",
    dependencies=requires_auth,
)
def get_tag(tag: str = Path(max_length=TAG_MAX_LENGTH)):
    if not tag_exists(tag):
        raise HTTPException(status_code=404, detail="Tag not found")
    return {"tag": tag}


@router.put(
    "/api/tags/{old_tag}",
    summary="Update a tag (rename). Uploads using the old tag are updated too.",
    dependencies=requires_auth,
)
def update_tag(
    old_tag: str = Path(max_length=TAG_MAX_LENGTH),
    new_tag: str | None = Query(default=None, max_length=TAG_MAX_LENGTH * 2),
):
    if new_tag is None:
        raise HTTPException(status_code=400, detail="New tag cannot be empty")
    new_tag = validate_tag(new_tag)
    if not tag_exists(old_tag):
        raise HTTPException(status_code=404, detail="Old tag not found")
    if tag_exists(new_tag):
        raise HTTPException(status_code=409, detail="New tag already exists")
    if not storage_update_tag(old_tag, new_tag):
        raise HTTPException(status_code=400, detail="Failed to update tag")
    return {"old_tag": old_tag, "new_tag": new_tag}


@router.get(
    "/api/uploads/{upload_id}/tags",
    summary="Get tags associated with an upload",
    dependencies=requires_auth,
)
def get_upload_tags(upload_id: UploadIdPath):
    get_upload_asserted_platform(upload_id)
    build_info = load_build_info(upload_id)
    return {"upload_id": upload_id, "tags": build_info.tags or load_upload_tags(upload_id)}
