from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "whatsapp_crm" / "Dockerfile"


def test_openwa_auth_cache_is_writable_without_disabling_rootfs_protection() -> None:
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    service = compose["services"]["whatsapp_crm_openwa"]

    assert service["read_only"] is True
    assert "/app/.wwebjs_cache:uid=997,gid=997,mode=0700,size=64m" in service["tmpfs"]
    assert "no-new-privileges:true" in service["security_opt"]
    assert "ALL" in service["cap_drop"]


def test_ocr_language_data_is_fetched_reproducibly() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "COPY eng.traineddata" not in dockerfile
    assert "tessdata_fast/${TESSDATA_REF}/eng.traineddata" in dockerfile
    assert "tessdata_fast/${TESSDATA_REF}/rus.traineddata" in dockerfile
    assert "TESSDATA_REF=87416418657359cb625c412a48b6e1d6d41c29bd" in dockerfile
    assert "TESSDATA_ENG_SHA256=7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2" in dockerfile
    assert "TESSDATA_RUS_SHA256=e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225" in dockerfile
    assert dockerfile.count("sha256sum -c -") == 2
    assert dockerfile.count("--retry 5") == 2


def test_ocr_download_tools_are_not_in_the_runtime_stage() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    stages = re.split(r"(?m)^FROM\s+\S+\s+AS\s+runner\s*$", dockerfile, maxsplit=1)
    assert len(stages) == 2, "The production runner stage must exist"
    runtime_stage = stages[1]

    assert "curl" not in runtime_stage
    assert "COPY --from=ocr-data /ocr_data/ ./ocr_data/" in runtime_stage


def test_node_stages_use_pinned_supported_runtime_and_lockfile() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    node_stages = re.findall(r"(?m)^FROM (node:\S+) AS (\S+)$", dockerfile)

    assert {name for _, name in node_stages} == {"frontend-builder", "backend-builder", "runner"}
    assert all(re.fullmatch(r"node:22\.23\.2-bookworm(?:-slim)?@sha256:[0-9a-f]{64}", image)
               for image, _ in node_stages)
    assert dockerfile.count("&& npm ci") == 2
    assert "npm install" not in dockerfile
