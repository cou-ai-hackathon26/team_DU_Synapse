from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ASSETS = Path(__file__).resolve().parents[1] / "assets"
ROOT = Path(__file__).resolve().parents[2]
PIPELINE = "evidence-review-1.2"
PARSER = "pdf-lines-1.0"
BUCKET = "evidence"
JOB_FIELDS = "id,case_id,kind,version_id,run_id,state,stage,completed,total,attempts,error,created_at,available_at"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / ".env", ".env"), extra="ignore")
    supabase_url: str = ""
    supabase_anon_key: str = Field(default="", repr=False)
    supabase_service_role_key: str = Field(default="", repr=False)
    app_url: str = "http://localhost:3000"
    admin_email: str = ""
    admin_password: str = Field(default="", repr=False)
    gemini_api_key: str = Field(default="", repr=False)
    gemini_api_keys: str = Field(default="", repr=False)
    llm_model: str = "gemini-3.5-flash-lite"
    embedding_model: str = "gemini-embedding-001"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    tessdata_prefix: str = str(
        ASSETS / "tessdata" if ASSETS.exists() else ROOT / ".local/tessdata"
    )
    worker_enabled: bool = True
    queue_enabled: bool = False
    min_request_interval: float = Field(default=1, ge=0)
    gemini_key_min_interval: float = Field(default=6, ge=0)
    sample_dir: Path = (
        ASSETS / "documents" if ASSETS.exists() else ROOT / "fixtures" / "demo"
    )

    def provenance(self):
        return {
            "pipeline": PIPELINE,
            "llm": self.llm_model,
            "embedding": self.embedding_model,
            "dimensions": 768,
            "second_opinion": "blind_same_model",
            "parser": PARSER,
        }

    def gemini_keys(self):
        pool = [key.strip() for key in self.gemini_api_keys.split(",") if key.strip()]
        if not pool and self.gemini_api_key:
            pool = [self.gemini_api_key.strip()]
        return list(dict.fromkeys(pool))


@lru_cache
def settings():
    return Settings()
