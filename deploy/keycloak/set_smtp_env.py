"""Prompt for the SMTP password and save it in the private identity .env."""

import getpass
import os
from datetime import datetime, timezone
from pathlib import Path


ENV_FILE = Path("/opt/ava-identity/.env")
SETTINGS = {
    "SYSTEM_SMTP_HOST": "mail.hosting.reg.ru",
    "SYSTEM_SMTP_PORT": "465",
    "SYSTEM_SMTP_SECURE": "true",
    "SYSTEM_SMTP_USER": "noreply@meludtech.tech",
    "SYSTEM_SMTP_FROM": "'\"AVA Security\" <noreply@meludtech.tech>'",
}


def write_private(path: Path, content: str, *, replace: bool = False) -> None:
    flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if replace else os.O_EXCL)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)
    path.chmod(0o600)


def main() -> None:
    if ENV_FILE.stat().st_mode & 0o077:
        raise RuntimeError("identity environment file must be private")
    password = getpass.getpass("SMTP password: ")
    if not password or "\n" in password or "\r" in password or "'" in password:
        raise RuntimeError("SMTP password contains unsupported characters")
    original = ENV_FILE.read_text()
    keys = set(SETTINGS) | {"SYSTEM_SMTP_PASS"}
    preserved = [line for line in original.splitlines()
                 if line.split("=", 1)[0].strip() not in keys]
    updated = "\n".join(preserved).rstrip("\n") + "\n"
    updated += "\n".join(f"{key}={value}" for key, value in SETTINGS.items()) + "\n"
    updated += f"SYSTEM_SMTP_PASS='{password}'\n"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = ENV_FILE.with_name(f".env.pre-smtp-{stamp}")
    write_private(backup, original)
    temporary = ENV_FILE.with_name(f".env.smtp-{os.getpid()}.tmp")
    try:
        write_private(temporary, updated)
        os.replace(temporary, ENV_FILE)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Private SMTP settings saved; backup: {backup}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        raise SystemExit(f"SMTP environment update failed ({type(exc).__name__})") from None
