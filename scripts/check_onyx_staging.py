#!/usr/bin/env python3
"""
Onyx Staging Health & Connectivity Inspector (Stage 1)
Checks connectivity to all components in the Onyx Staging stack.
"""

import sys
import json
import socket
import urllib.request
import urllib.error
from typing import Dict, Any

SERVICES = [
    {"name": "Onyx Backend API", "host": "127.0.0.1", "port": 8080, "url": "http://127.0.0.1:8080/api/health"},
    {"name": "Onyx Web UI", "host": "127.0.0.1", "port": 3001, "url": "http://127.0.0.1:3001"},
    {"name": "Onyx PostgreSQL", "host": "127.0.0.1", "port": 5433, "url": None},
    {"name": "Onyx Redis", "host": "127.0.0.1", "port": 6380, "url": None},
    {"name": "Onyx MinIO API", "host": "127.0.0.1", "port": 9002, "url": "http://127.0.0.1:9002/minio/health/live"},
    {"name": "Onyx Search (Vespa)", "host": "127.0.0.1", "port": 19071, "url": "http://127.0.0.1:19071/state/v1/health"},
    {"name": "Onyx Model Server", "host": "127.0.0.1", "port": 9000, "url": "http://127.0.0.1:9000/health"},
]


def check_tcp_port(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def check_http_url(url: str, timeout: float = 2.0) -> Dict[str, Any]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AVA-Onyx-HealthCheck/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"accessible": True, "code": resp.status}
    except urllib.error.HTTPError as e:
        return {"accessible": True, "code": e.code}
    except Exception as e:
        return {"accessible": False, "error": str(e)}


def inspect_staging() -> Dict[str, Any]:
    results = []
    total_up = 0

    for svc in SERVICES:
        tcp_ok = check_tcp_port(svc["host"], svc["port"])
        http_res = check_http_url(svc["url"]) if svc["url"] and tcp_ok else None
        
        status = "UP" if tcp_ok else "DOWN"
        if tcp_ok:
            total_up += 1

        results.append({
            "service": svc["name"],
            "host": svc["host"],
            "port": svc["port"],
            "tcp_open": tcp_ok,
            "http_status": http_res,
            "status": status
        })

    return {
        "total_services": len(SERVICES),
        "services_up": total_up,
        "services_down": len(SERVICES) - total_up,
        "all_healthy": (total_up == len(SERVICES)),
        "services": results
    }


def main():
    print("==================================================")
    print("   ONYX STAGING HEALTH & CONNECTIVITY INSPECTION")
    print("==================================================")
    
    report = inspect_staging()
    print(f"Status: {report['services_up']}/{report['total_services']} services reachable.\n")
    
    for s in report["services"]:
        mark = "✓ [UP]  " if s["tcp_open"] else "✗ [DOWN]"
        print(f" {mark} {s['service']:<25} -> {s['host']}:{s['port']}")

    print("\nDetailed JSON Output:")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
