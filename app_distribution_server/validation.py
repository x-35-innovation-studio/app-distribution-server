import re
import unicodedata
from typing import Annotated

from fastapi import HTTPException, Path

# Upload IDs are always generated server-side with uuid4().
UPLOAD_ID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_UPLOAD_ID_RE = re.compile(UPLOAD_ID_PATTERN)

BUNDLE_ID_PATTERN = r"^[a-zA-Z0-9\.\-\_]{1,256}$"

# Tags: start with an alphanumeric, then letters, digits, spaces, dot, dash, underscore.
TAG_MAX_LENGTH = 64
TAG_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,63}$"
_TAG_RE = re.compile(TAG_PATTERN)
MAX_TAGS_PER_UPLOAD = 20

MAX_METADATA_LENGTH = 256


def is_valid_upload_id(upload_id: str) -> bool:
    return bool(_UPLOAD_ID_RE.match(upload_id))


UploadIdPath = Annotated[
    str,
    Path(
        pattern=UPLOAD_ID_PATTERN,
        description="The upload ID (UUID) returned when the build was uploaded",
    ),
]


def validate_tag(tag: str) -> str:
    tag = tag.strip()
    if not tag:
        raise HTTPException(status_code=400, detail="Tag cannot be empty")
    if not _TAG_RE.match(tag):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid tag. Tags must be 1-{TAG_MAX_LENGTH} characters, start with a letter "
                "or digit, and contain only letters, digits, spaces, '.', '-' or '_'."
            ),
        )
    return tag


def sanitize_metadata(value: object, fallback: str = "unknown") -> str:
    """
    Normalise metadata extracted from an uploaded build (app title, version...).
    These values are attacker controlled, so strip control characters and cap the length.
    Output encoding (HTML/XML escaping) still happens at render time.
    """
    if value is None:
        return fallback

    text = str(value)
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    text = text.strip()[:MAX_METADATA_LENGTH]
    return text or fallback
