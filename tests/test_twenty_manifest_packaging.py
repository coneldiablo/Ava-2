"""Production image must carry the same schema as deployment tooling."""
import json
from pathlib import Path


def test_twenty_runtime_schema_is_in_docker_context_and_matches_deployment():
    root = Path(__file__).resolve().parents[1]
    packaged = root / "whatsapp_crm/src/services/twenty/schema-manifest.json"
    deployment = root / "deploy/twenty/schema-manifest.json"
    assert packaged.read_bytes() == deployment.read_bytes()
    schema = json.loads(packaged.read_text())
    assert schema["twenty_release"] == "v2.37.0"
    assert len(schema["custom_objects"]) == 7
    dockerfile = (root / "whatsapp_crm/Dockerfile").read_text()
    assert "COPY src/ ./src" in dockerfile
