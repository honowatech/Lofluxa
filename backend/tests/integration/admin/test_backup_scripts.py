"""Sauvegarde puis restauration réelles avec `infra/backup/*.sh` (critère d'acceptation 6).

Le test crée deux bases jetables sur le PostgreSQL local, sans toucher à la base de test. Il est ignoré
si les outils nécessaires (pg_dump, pg_restore, psql, gpg) ne sont pas installés.
"""

import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

from app.core.config import get_config

BACKUP_DIR = Path(__file__).resolve().parents[4] / "infra" / "backup"
TOOLS = ("pg_dump", "pg_restore", "psql", "gpg", "bash")
PASSPHRASE = "phrase-secrete-des-tests-automatiques"

pytestmark = pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in TOOLS) or not (BACKUP_DIR / "backup.sh").exists(),
    reason="outils de sauvegarde absents (pg_dump, pg_restore, psql, gpg)",
)


@pytest.fixture
def pg_env() -> dict[str, str]:
    url = make_url(get_config().database_url)
    return {
        **os.environ,
        "PGHOST": url.host or "localhost",
        "PGPORT": str(url.port or 5432),
        "PGUSER": url.username or "",
        "PGPASSWORD": url.password or "",
        "BACKUP_PASSPHRASE": PASSPHRASE,
    }


def _psql(env: dict[str, str], database: str, sql: str) -> str:
    result = subprocess.run(
        ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", sql],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _script(name: str, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(BACKUP_DIR / name), *args], env=env, capture_output=True, text=True, timeout=120
    )


@pytest.fixture
def databases(pg_env):
    suffix = uuid.uuid4().hex[:8]
    source, target = f"tourneo_l8_src_{suffix}", f"tourneo_l8_dst_{suffix}"
    _psql(pg_env, "postgres", f'CREATE DATABASE "{source}"')
    _psql(
        pg_env,
        source,
        "CREATE EXTENSION IF NOT EXISTS postgis; "
        "CREATE TABLE depots_demo ("
        " code text PRIMARY KEY, location geography(Point, 4326), stock numeric(12,3)); "
        "INSERT INTO depots_demo VALUES"
        " ('SCDP-DLA', ST_SetSRID(ST_MakePoint(9.7043, 4.0483), 4326), 120000.500),"
        " ('SCDP-YDE', ST_SetSRID(ST_MakePoint(11.5021, 3.8480), 4326), 80000); "
        "CREATE INDEX ix_depots_demo_location ON depots_demo USING gist (location);",
    )
    yield source, target
    for name in (source, target, f"{target}_restore_tmp"):
        _psql(pg_env, "postgres", f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


FINGERPRINT = (
    "SELECT string_agg(code || '|' || ST_AsText(location::geometry) || '|' || stock, ';' ORDER BY code) "
    "FROM depots_demo"
)


def test_sauvegarde_chiffree_puis_restauration_sur_base_vierge(pg_env, databases, tmp_path):
    source, target = databases
    env = {**pg_env, "BACKUP_DIR": str(tmp_path)}

    backup = _script("backup.sh", {**env, "PGDATABASE": source}, "--no-offsite")
    assert backup.returncode == 0, backup.stderr
    files = sorted(tmp_path.glob("tourneo_*.dump.gpg"))
    assert len(files) == 1
    assert (tmp_path / (files[0].name + ".sha256")).exists()
    assert (tmp_path / ".last_status").read_text().startswith("ok ")
    # Chiffrée : ni l'en-tête d'un dump PostgreSQL ni les données ne sont lisibles en clair.
    raw = files[0].read_bytes()
    assert not raw.startswith(b"PGDMP") and b"SCDP-DLA" not in raw and b"depots_demo" not in raw

    # La base cible n'existe pas : c'est le cas d'une machine vierge.
    restore = _script("restore.sh", {**env, "PGDATABASE": target}, "latest", "--yes")
    assert restore.returncode == 0, restore.stderr
    assert _psql(pg_env, target, FINGERPRINT) == _psql(pg_env, source, FINGERPRINT)
    assert (
        _psql(pg_env, target, "SELECT count(*) FROM pg_indexes WHERE indexname = 'ix_depots_demo_location'")
        == "1"
    )
    assert _psql(pg_env, target, "SELECT count(*) FROM pg_extension WHERE extname = 'postgis'") == "1"


def test_restauration_refusee_sans_toucher_a_la_base_en_service(pg_env, databases, tmp_path):
    source, target = databases
    env = {**pg_env, "BACKUP_DIR": str(tmp_path)}
    assert _script("backup.sh", {**env, "PGDATABASE": source}, "--no-offsite").returncode == 0
    _psql(pg_env, "postgres", f'CREATE DATABASE "{target}"')
    _psql(pg_env, target, "CREATE TABLE en_service AS SELECT 1 AS v")

    wrong = _script(
        "restore.sh",
        {**env, "PGDATABASE": target, "BACKUP_PASSPHRASE": "une-autre-phrase-secrete"},
        "latest",
        "--yes",
    )
    assert wrong.returncode != 0 and "mauvaise phrase secrète" in wrong.stderr

    backup_file = next(tmp_path.glob("tourneo_*.dump.gpg"))
    corrupted = bytearray(backup_file.read_bytes())
    corrupted[len(corrupted) // 2] ^= 0xFF
    backup_file.write_bytes(bytes(corrupted))
    tampered = _script("restore.sh", {**env, "PGDATABASE": target}, "latest", "--yes")
    assert tampered.returncode != 0 and "SHA-256" in tampered.stderr

    # Sans --yes, une réponse autre que « oui » annule tout.
    assert _psql(pg_env, target, "SELECT v FROM en_service") == "1"


def test_sauvegarde_refusee_sans_phrase_secrete_et_retention(pg_env, databases, tmp_path):
    source, _target = databases
    env = {**pg_env, "BACKUP_DIR": str(tmp_path), "PGDATABASE": source}

    missing = _script("backup.sh", {**env, "BACKUP_PASSPHRASE": ""}, "--no-offsite")
    assert missing.returncode != 0 and "phrase secrète absente" in missing.stderr
    assert list(tmp_path.glob("*.dump.gpg*")) == []

    old = tmp_path / "tourneo_20200101T020000Z.dump.gpg"
    recent = tmp_path / "tourneo_20991231T020000Z.dump.gpg"
    for path, age_days in ((old, 15), (recent, 13)):
        path.write_bytes(b"x")
        stamp = path.stat().st_mtime - age_days * 86400
        os.utime(path, (stamp, stamp))
    done = _script("backup.sh", {**env, "BACKUP_RETENTION_DAYS": "14"}, "--no-offsite")
    assert done.returncode == 0, done.stderr
    assert not old.exists(), "une sauvegarde de plus de 14 jours doit être supprimée"
    assert recent.exists(), "une sauvegarde de moins de 14 jours doit être conservée"
    assert len(list(tmp_path.glob("tourneo_*.dump.gpg"))) == 2


def test_copie_hors_serveur_par_rclone(pg_env, databases, tmp_path):
    if shutil.which("rclone") is None:
        pytest.skip("rclone absent")
    source, _target = databases
    local, remote = tmp_path / "local", tmp_path / "distant"
    local.mkdir()
    env = {**pg_env, "BACKUP_DIR": str(local), "PGDATABASE": source, "RCLONE_REMOTE": str(remote)}
    done = _script("backup.sh", env, "--offsite")
    assert done.returncode == 0, done.stderr
    copied = sorted(path.name for path in remote.iterdir())
    assert copied == sorted(path.name for path in local.glob("tourneo_*"))
    assert len(copied) == 2  # le fichier chiffré et son empreinte
