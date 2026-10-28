#!/usr/bin/env python3
"""Idempotently provision the AVA projection schema in a Twenty workspace."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class TwentyApiError(RuntimeError):
    pass


class TwentyMetadataClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/rest/metadata{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read(2_000).decode("utf-8", errors="replace")
            raise TwentyApiError(f"Twenty metadata API returned HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise TwentyApiError(f"Twenty metadata API is unavailable: {exc.reason}") from exc

    def list_all(self, resource: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            query = {"limit": "60"}
            if cursor:
                query["starting_after"] = cursor
            response = self.request("GET", f"/{resource}?{urllib.parse.urlencode(query)}")
            page_items = response.get("data", [])
            if not isinstance(page_items, list):
                raise TwentyApiError(f"Unexpected Twenty response for {resource}")
            items.extend(page_items)
            page_info = response.get("pageInfo") or {}
            if not page_info.get("hasNextPage"):
                return items
            next_cursor = page_info.get("endCursor")
            if not next_cursor or next_cursor == cursor:
                raise TwentyApiError(f"Invalid pagination cursor for {resource}")
            cursor = str(next_cursor)

    def create(self, resource: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self.request("POST", f"/{resource}", payload)
        value = response.get("data", response) if isinstance(response, dict) else response
        if not isinstance(value, dict) or not value.get("id"):
            raise TwentyApiError(f"Twenty did not return an id for the new {resource} record")
        return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("TWENTY_BASE_URL", "http://127.0.0.1:3000"))
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).with_name("schema-manifest.json"),
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_key = os.environ.get("TWENTY_API_KEY", "").strip()
    if not api_key:
        print("TWENTY_API_KEY is required", file=sys.stderr)
        return 2
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    definitions = manifest.get("field_definitions") or {}
    client = TwentyMetadataClient(args.base_url, api_key)

    objects = {item["namePlural"]: item for item in client.list_all("objects")}
    fields = client.list_all("fields")
    fields_by_object: dict[str, dict[str, dict[str, Any]]] = {}
    for field in fields:
        fields_by_object.setdefault(str(field.get("objectMetadataId")), {})[str(field.get("name"))] = field

    created_objects = 0
    created_fields = 0
    verified_fields = 0

    for expected in manifest.get("custom_objects", []):
        plural = expected["namePlural"]
        existing = objects.get(plural)
        if existing is None:
            if args.dry_run:
                print(f"would_create_object={plural}")
                existing = {"id": f"dry-run:{plural}", "namePlural": plural}
            else:
                existing = client.create(
                    "objects",
                    {
                        "nameSingular": expected["nameSingular"],
                        "namePlural": plural,
                        "labelSingular": expected["labelSingular"],
                        "labelPlural": expected["labelPlural"],
                        "description": f"Безопасная tenant-scoped проекция AVA: {expected['labelPlural']}",
                        "icon": "IconHotelService",
                    },
                )
                created_objects += 1
            objects[plural] = existing
            fields_by_object.setdefault(existing["id"], {})

    field_plan: list[tuple[str, str]] = []
    for object_name, names in (manifest.get("standard_object_fields") or {}).items():
        field_plan.extend((object_name, name) for name in names)
    for custom_object in manifest.get("custom_objects", []):
        field_plan.extend((custom_object["namePlural"], name) for name in custom_object.get("fields", []))

    for object_name, field_name in field_plan:
        object_metadata = objects.get(object_name)
        if object_metadata is None:
            raise TwentyApiError(f"Twenty object is missing: {object_name}")
        definition = definitions.get(field_name)
        if not definition:
            raise TwentyApiError(f"Field definition is missing in the manifest: {field_name}")
        object_fields = fields_by_object.setdefault(object_metadata["id"], {})
        existing_field = object_fields.get(field_name)
        if existing_field is not None:
            existing_type = str(existing_field.get("type") or "").upper()
            expected_type = str(definition["type"]).upper()
            if existing_type != expected_type:
                raise TwentyApiError(
                    f"Type mismatch for {object_name}.{field_name}: {existing_type} != {expected_type}"
                )
            verified_fields += 1
            continue
        if args.dry_run:
            print(f"would_create_field={object_name}.{field_name}:{definition['type']}")
            continue
        created = client.create(
            "fields",
            {
                "type": definition["type"],
                "objectMetadataId": object_metadata["id"],
                "name": field_name,
                "label": definition["label"],
                "description": "Синхронизируется из AVA; tenant scope проверяется на стороне AVA.",
                "isNullable": True,
            },
        )
        object_fields[field_name] = created
        created_fields += 1

    print(f"objects_created={created_objects}")
    print(f"fields_created={created_fields}")
    print(f"fields_verified={verified_fields}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
