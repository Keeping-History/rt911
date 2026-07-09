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

    # --- Audio transcription (whisper.cpp) ---
    whisper_bin: str = field(default_factory=lambda: os.getenv("WHISPER_BIN", "whisper-cli"))
    whisper_model: str = field(default_factory=lambda: os.getenv("WHISPER_MODEL", "/opt/models/ggml-medium.en.bin"))
    whisper_threads: int = field(default_factory=lambda: _int("WHISPER_THREADS", 4))
    subtitles_prefix: str = field(default_factory=lambda: os.getenv("SUBTITLES_PREFIX", "subtitles"))

    # --- Usenet newsgroup ingestion ---
    # IA collections to scan for newsgroup mbox archives. usenethistorical is
    # entirely pre-2001; giganews is large and straddles the cutoff (trimmed per
    # message at the process stage). See plans/usenet-archive-ingestion.md.
    usenet_collections: str = field(default_factory=lambda: os.getenv("USENET_COLLECTIONS", "usenethistorical,giganews"))
    # Per-message cutoff passed to mbox_parser --before. Keep messages on or before
    # this date (exclusive of later), so the replay never reveals "future" posts.
    usenet_before: str = field(default_factory=lambda: os.getenv("USENET_BEFORE", "2001-09-21"))
    # A usenet_jobs row untouched (no heartbeat / transition) this long while in an
    # in-flight stage (downloading/downloaded/processing) is treated as orphaned by
    # a dead process-usenet-item run and re-queued at the head of dispatch-usenet.
    # Must exceed the heartbeat interval (60s) by a comfortable margin.
    usenet_orphan_stale_minutes: int = field(default_factory=lambda: _int("USENET_ORPHAN_STALE_MINUTES", 10))

    # --- Channel thumbnail generation ---
    # Real-world UTC timestamp when the virtual clock was set to the channel window's
    # start_date (2001-09-09T00:00:00Z). Used to compute virtual_now as:
    #   start_date + (real_now - VIRTUAL_EPOCH_REAL) % window_duration
    virtual_epoch_real: str = field(
        default_factory=lambda: os.getenv("VIRTUAL_EPOCH_REAL", "2026-06-25T13:00:00+00:00")
    )

    def usenet_collection_list(self) -> list[str]:
        return [c.strip() for c in self.usenet_collections.split(",") if c.strip()]
