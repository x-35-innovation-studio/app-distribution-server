import io
import os
import plistlib
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from enum import Enum
from io import BytesIO
from uuid import uuid4

from androguard.core.apk import APK, get_apkid
from pydantic import BaseModel, ValidationError, field_validator

from app_distribution_server.errors import InvalidFileTypeError
from app_distribution_server.logger import logger
from app_distribution_server.validation import BUNDLE_ID_PATTERN, sanitize_metadata


class Platform(str, Enum):
    ios = "ios"
    android = "android"

    @property
    def display_name(self):
        match = {
            self.ios: "iOS",
            self.android: "Android",
        }
        return match[self]

    @property
    def app_file_name(self):
        match = {
            self.ios: "app.ipa",
            self.android: "app.apk",
        }
        return match[self]


class LegacyAppInfo(BaseModel):
    """
    This was the structure used by v1.
    We keep this model unchanged in order to perform the migration from the old app_info.json fle.
    """

    app_title: str
    bundle_id: str
    bundle_version: str

    @field_validator("bundle_id")
    def validate_bundle_id(cls, v):
        if not re.match(BUNDLE_ID_PATTERN, v):
            raise ValueError(
                "Bundle ID can only contain alphanumeric characters, dots, hyphens and underscores."
            )
        return v


class BuildInfo(LegacyAppInfo):
    upload_id: str
    file_size: int
    created_at: datetime | None
    platform: Platform
    tags: list[str] = []  # Optional tags field, default empty list

    @property
    def human_file_size(self) -> str:
        one_kb = 1024
        if self.file_size is None:
            return "unknown size"

        if self.file_size < one_kb:
            return f"{self.file_size}B"

        if self.file_size < one_kb**2:
            return f"{self.file_size / one_kb:.2f}KB"

        if self.file_size < one_kb**3:
            return f"{self.file_size / one_kb**2:.2f}MB"

        return f"{self.file_size / one_kb**3:.2f}GB"


_IPA_INFO_PLIST_RE = re.compile(r"^Payload/[^/]+\.app/Info\.plist$")
_MAX_INFO_PLIST_SIZE = 5 * 1024 * 1024  # 5MB is far more than any real Info.plist


def get_build_info_from_ipa(
    upload_id: str,
    ipa_file: BytesIO,
) -> BuildInfo:
    try:
        ipa = zipfile.ZipFile(ipa_file, "r")
    except zipfile.BadZipFile as e:
        logger.warning("Uploaded IPA is not a valid zip archive")
        raise InvalidFileTypeError() from e

    with ipa:
        entries = ipa.infolist()
        # Prefer the top level app bundle; fall back to any *.app/Info.plist (legacy behaviour).
        candidates = [e for e in entries if _IPA_INFO_PLIST_RE.match(e.filename)] or [
            e for e in entries if e.filename.endswith(".app/Info.plist")
        ]

        for entry in candidates:
            if entry.file_size > _MAX_INFO_PLIST_SIZE:
                logger.warning("Info.plist inside IPA is suspiciously large, skipping")
                continue

            try:
                info = plistlib.loads(ipa.read(entry))
            except Exception as e:
                logger.warning("Failed to parse Info.plist from IPA")
                raise InvalidFileTypeError() from e

            if not isinstance(info, dict):
                raise InvalidFileTypeError()

            bundle_id = info.get("CFBundleIdentifier")
            app_title = info.get("CFBundleName")
            bundle_version = info.get("CFBundleShortVersionString")

            if not isinstance(bundle_id, str) or app_title is None or bundle_version is None:
                logger.error("Failed to extract plist file information")
                raise InvalidFileTypeError()

            return _build_info_or_invalid(
                upload_id=upload_id,
                platform=Platform.ios,
                app_title=app_title,
                bundle_id=bundle_id,
                bundle_version=bundle_version,
                file_size=ipa_file.getbuffer().nbytes,
            )

    logger.error("Could not find plist file in bundle")
    raise InvalidFileTypeError()


def _build_info_or_invalid(
    upload_id: str,
    platform: Platform,
    app_title: object,
    bundle_id: object,
    bundle_version: object,
    file_size: int,
) -> BuildInfo:
    try:
        return BuildInfo(
            upload_id=upload_id,
            platform=platform,
            app_title=sanitize_metadata(app_title, fallback="Untitled app"),
            bundle_id=str(bundle_id),
            bundle_version=sanitize_metadata(bundle_version),
            created_at=datetime.now(timezone.utc),
            file_size=file_size,
        )
    except ValidationError as e:
        logger.warning("Uploaded build has invalid metadata")
        raise InvalidFileTypeError() from e


def get_build_info_from_apk(
    upload_id: str,
    apk_file: BytesIO,
) -> BuildInfo:
    tempdir = tempfile.mkdtemp()
    file_name = "app.apk"
    file_path = os.path.join(tempdir, file_name)

    try:
        with open(file_path, "wb") as f:
            f.write(apk_file.read())

        try:
            bundle_id, _, version_name = get_apkid(file_path)
            apk = APK(file_path)
            app_title = apk.get_app_name()
        except Exception as e:
            logger.warning("Failed to parse uploaded APK")
            raise InvalidFileTypeError() from e

        if not bundle_id:
            raise InvalidFileTypeError()

        return _build_info_or_invalid(
            upload_id=upload_id,
            platform=Platform.android,
            app_title=app_title,
            bundle_id=bundle_id,
            bundle_version=version_name,
            file_size=apk_file.getbuffer().nbytes,
        )
    finally:
        shutil.rmtree(tempdir)


def get_build_info(
    platform: Platform,
    app_file_content: bytes,
):
    upload_id = str(uuid4())

    logger.debug(f"Obtaining build info from {upload_id!r}")

    file_contents_stream = io.BytesIO(app_file_content)

    if platform == Platform.ios:
        return get_build_info_from_ipa(
            upload_id,
            file_contents_stream,
        )

    return get_build_info_from_apk(
        upload_id,
        file_contents_stream,
    )
