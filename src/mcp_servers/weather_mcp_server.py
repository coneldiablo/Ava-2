#!/usr/bin/env python3
"""Simple MCP weather server using Open-Meteo API."""
import sys
import json
import urllib.request
import urllib.parse
import re

def send_response(req_id, result):
    msg = {"jsonrpc": "2.0", "id": req_id, "result": result}
    body = json.dumps(msg)
    sys.stdout.write(f"Content-Length: {len(body)}\r\n\r\n{body}")
    sys.stdout.flush()

def normalize_city(city):
    """Extract just the city name, stripping state/country."""
    # Remove common patterns like "City, State" or "City, Country"
    parts = re.split(r',\s*', city.strip())
    return parts[0].strip() if parts else city.strip()

def geocode(city):
    # Normalize city name to just the city part
    city_only = normalize_city(city)
    encoded_city = urllib.parse.quote(city_only, safe="")
    # Ask Open-Meteo for several localized matches. Without language=ru,
    # "Москва" can resolve to "Moskva" in Tajikistan before Moscow, Russia.
    url = f"https://geocoding-api.open-meteo.com/v1/search?name={encoded_city}&count=10&language=ru"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    if data.get("results"):
        results = data["results"]
        city_lc = city_only.casefold()

        # Prefer Russian locations for Cyrillic city names when available.
        # This keeps demo phrases like "погода в Москве" on Moscow, RU.
        if re.search(r"[а-яА-ЯёЁ]", city_only):
            for r in results:
                if r.get("country_code") == "RU":
                    return r["latitude"], r["longitude"], r.get("name", city_only)

        # In this demo/business context, "Moscow" almost always means Moscow, Russia,
        # not smaller same-name towns returned by global geocoding.
        if city_lc in {"moscow", "moskva"}:
            for r in results:
                if r.get("country_code") == "RU":
                    return r["latitude"], r["longitude"], r.get("name", city_only)

        # Prefer an exact localized name match before falling back to API order.
        for r in results:
            if str(r.get("name", "")).casefold() == city_lc:
                return r["latitude"], r["longitude"], r.get("name", city_only)

        r = results[0]
        return r["latitude"], r["longitude"], r.get("name", city_only)
    return None, None, city

def get_weather(lat, lon):
    current_fields = ",".join([
        "temperature_2m",
        "apparent_temperature",
        "weather_code",
        "precipitation",
        "rain",
        "snowfall",
        "cloud_cover",
        "wind_speed_10m",
    ])
    url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current={current_fields}&timezone=auto"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    current = data.get("current", {})
    temp = current.get("temperature_2m", "unknown")
    feels_like = current.get("apparent_temperature")
    code = current.get("weather_code", 0)
    desc = {
        0: "clear",
        1: "mainly clear",
        2: "partly cloudy",
        3: "overcast",
        45: "foggy",
        48: "depositing rime fog",
        51: "light drizzle",
        53: "moderate drizzle",
        55: "dense drizzle",
        56: "light freezing drizzle",
        57: "dense freezing drizzle",
        61: "light rain",
        63: "moderate rain",
        65: "heavy rain",
        66: "light freezing rain",
        67: "heavy freezing rain",
        71: "light snow",
        73: "moderate snow",
        75: "heavy snow",
        77: "snow grains",
        80: "light rain showers",
        81: "moderate rain showers",
        82: "violent rain showers",
        85: "light snow showers",
        86: "heavy snow showers",
        95: "thunderstorm",
        96: "thunderstorm with slight hail",
        99: "thunderstorm with heavy hail",
    }.get(code, "variable")
    return {
        "temperature": temp,
        "feels_like": feels_like,
        "description": desc,
        "weather_code": code,
        "precipitation": current.get("precipitation"),
        "rain": current.get("rain"),
        "snowfall": current.get("snowfall"),
        "cloud_cover": current.get("cloud_cover"),
        "wind_speed": current.get("wind_speed_10m"),
        "time": current.get("time"),
    }

def main():
    stdin = sys.stdin.buffer
    buffer = b""
    while True:
        chunk = stdin.read(1)
        if not chunk:
            break
        buffer += chunk
        if b"Content-Length:" in buffer and b"\r\n\r\n" in buffer:
            try:
                header_end = buffer.index(b"\r\n\r\n")
                header = buffer[:header_end].decode("ascii")
                content_length = None
                for h in header.split("\r\n"):
                    if h.lower().startswith("content-length:"):
                        content_length = int(h.split(":")[1].strip())
                        break
                if content_length is None:
                    buffer = b""
                    continue
                body_start = header_end + 4
                if len(buffer) >= body_start + content_length:
                    body = buffer[body_start:body_start + content_length].decode("utf-8")
                    buffer = buffer[body_start + content_length:]
                    msg = json.loads(body)
                    method = msg.get("method", "")
                    req_id = msg.get("id")
                    params = msg.get("params", {})
                    
                    if method == "initialize":
                        send_response(req_id, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "weather", "version": "1.0.0"}})
                    elif method == "tools/list":
                        send_response(req_id, {"tools": [{"name": "get_weather_by_city", "description": "Get current weather for a city", "inputSchema": {"type": "object", "properties": {"city": {"type": "string", "description": "City name"}}, "required": ["city"]}}]})
                    elif method == "tools/call":
                        tool_name = params.get("name", "")
                        args = params.get("arguments", {})
                        if tool_name == "get_weather_by_city":
                            city = args.get("city", "")
                            try:
                                lat, lon, name = geocode(city)
                                if lat is None:
                                    spoken = f"I could not find weather data for {city}."
                                else:
                                    weather = get_weather(lat, lon)
                                    temp = weather.get("temperature")
                                    desc = weather.get("description")
                                    feels = weather.get("feels_like")
                                    snow = weather.get("snowfall") or 0
                                    rain = weather.get("rain") or 0
                                    extra = []
                                    if feels is not None:
                                        extra.append(f"feels like {feels} degrees")
                                    if snow:
                                        extra.append(f"snowfall {snow} mm")
                                    elif rain:
                                        extra.append(f"rain {rain} mm")
                                    extra_text = f", {', '.join(extra)}" if extra else ""
                                    spoken = f"The weather in {name} is {desc}, {temp} degrees Celsius{extra_text}."
                                send_response(req_id, {"content": [{"type": "text", "text": spoken}], "structured": {"spoken": spoken, "weather": weather if lat is not None else None}})
                            except Exception as e:
                                send_response(req_id, {"content": [{"type": "text", "text": f"Weather lookup failed: {e}"}], "structured": {"spoken": f"Sorry, I could not get the weather. {e}"}})
                        else:
                            send_response(req_id, {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}]})
                    elif method == "notifications/initialized":
                        pass
                    else:
                        if req_id is not None:
                            send_response(req_id, {})
            except Exception as e:
                sys.stderr.write(f"Error: {e}\n")
                sys.stderr.flush()
                buffer = b""

if __name__ == "__main__":
    main()
