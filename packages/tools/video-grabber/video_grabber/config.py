from dataclasses import dataclass, field
import os


def _int(key: str, default: int) -> int:
    return int(os.getenv(key, str(default)))


@dataclass
class Config:
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", ""))
    wasabi_endpoint: str = field(default_factory=lambda: os.getenv("WASABI_ENDPOINT_URL", "https://s3.us-central-1.wasabisys.com"))
    wasabi_bucket: str = field(default_factory=lambda: os.getenv("WASABI_BUCKET", "files.911realtime.org"))
    wasabi_key: str = field(default_factory=lambda: os.getenv("WASABI_ACCESS_KEY_ID", ""))
    wasabi_secret: str = field(default_factory=lambda: os.getenv("WASABI_SECRET_ACCESS_KEY", ""))
    directus_url: str = field(default_factory=lambda: os.getenv("DIRECTUS_URL", "http://localhost:8055"))
    directus_email: str = field(default_factory=lambda: os.getenv("ADMIN_EMAIL", ""))
    directus_password: str = field(default_factory=lambda: os.getenv("ADMIN_PASSWORD", ""))
    directus_api_token: str = field(default_factory=lambda: os.getenv("DIRECTUS_API_TOKEN", ""))
    ia_rate_per_sec: int = field(default_factory=lambda: _int("IA_RATE_PER_SEC", 2))
    min_duration_seconds: int = field(default_factory=lambda: _int("MIN_DURATION_SECONDS", 720))
