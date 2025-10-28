"""Application configuration settings."""
from __future__ import annotations

import importlib.util
from functools import lru_cache
from typing import Dict, Type
from urllib.parse import urlencode

from pydantic import Field, HttpUrl


class _SettingsFields:
    """Shared field definitions for the application settings."""

    odds_endpoint_base: HttpUrl = Field(
        "https://global.ds.lsapp.eu/odds/pq_graphql",
        description="Base URL for the FlashScore odds endpoint.",
    )
    odds_hash: str = Field(
        "oce",
        description="Hash query parameter required by the odds endpoint.",
    )
    project_id: int = Field(
        1,
        description="Project identifier used when requesting odds data.",
    )
    geo_ip_code: str = Field(
        "CZ",
        description="Geo IP country code parameter for the odds endpoint.",
    )
    geo_ip_subdivision_code: str = Field(
        "CZ10",
        description="Geo IP subdivision code parameter for the odds endpoint.",
    )
    default_headers: Dict[str, str] = Field(
        default_factory=lambda: {
            "Accept": "*/*",
            "Sec-Fetch-Site": "cross-site",
            "Origin": "https://www.livesport.cz",
            "Sec-Fetch-Dest": "empty",
            "Accept-Language": "cs-CZ,cs;q=0.9",
            "Sec-Fetch-Mode": "cors",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                "Version/18.3.1 Safari/605.1.15"
            ),
            "Accept-Encoding": "gzip, deflate, br",
            "Referer": "https://www.livesport.cz/",
            "Priority": "u=3, i",
        },
        description="Default headers sent to the odds endpoint.",
    )

    def build_odds_url(self, event_id: str) -> str:
        """Construct the odds endpoint URL for the provided event."""

        query_params = {
            "_hash": self.odds_hash,
            "eventId": event_id,
            "projectId": str(self.project_id),
            "geoIpCode": self.geo_ip_code,
            "geoIpSubdivisionCode": self.geo_ip_subdivision_code,
        }
        return f"{self.odds_endpoint_base}?{urlencode(query_params)}"


def _get_base_settings_class() -> Type[_SettingsFields]:
    """Return the appropriate Pydantic settings base class.

    Pydantic v2 exposes BaseSettings via the external ``pydantic-settings`` package
    while Pydantic v1 provides it directly from ``pydantic``. Detect the available
    implementation so the application keeps working across both versions without
    forcing an additional dependency.
    """

    if importlib.util.find_spec("pydantic_settings"):
        from pydantic_settings import BaseSettings, SettingsConfigDict  # type: ignore

        class SettingsBase(_SettingsFields, BaseSettings):
            model_config = SettingsConfigDict(env_file=".env", env_prefix="APP_")

        return SettingsBase

    from pydantic import BaseSettings  # type: ignore

    class SettingsBase(_SettingsFields, BaseSettings):
        class Config:
            env_file = ".env"
            env_prefix = "APP_"

    return SettingsBase


Settings: Type[_SettingsFields] = _get_base_settings_class()


@lru_cache
def get_settings() -> _SettingsFields:
    """Return a cached Settings instance."""

    return Settings()
