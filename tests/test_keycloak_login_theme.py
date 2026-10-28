"""Guard the customer login theme without replacing Keycloak auth templates."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "deploy" / "keycloak"
THEME = ROOT / "themes" / "ava" / "login"


def test_ava_realm_uses_native_login_with_custom_theme():
    realm = json.loads((ROOT / "ava-realm.json").read_text())
    assert realm["loginTheme"] == "ava"
    assert realm["registrationAllowed"] is False
    assert realm["bruteForceProtected"] is True
    assert not list(THEME.rglob("*.ftl")), "Do not replace native authentication templates"


def test_theme_assets_are_resolved_and_keep_visible_focus():
    properties = (THEME / "theme.properties").read_text()
    assert "parent=keycloak" in properties
    styles = next(line for line in properties.splitlines() if line.startswith("styles="))
    for stylesheet in styles.removeprefix("styles=").split():
        assert stylesheet == "css/login.css" or (THEME / "resources" / stylesheet).is_file()
    css = (THEME / "resources" / "css" / "ava-v2.css").read_text()
    assert ".login-pf-page" in css
    assert "#kc-form-login" in css
    assert ":focus-visible" in css
    assert "prefers-reduced-motion" in css
    assert "max-width: 480px" in css


def test_theme_is_read_only_inside_keycloak():
    override = (ROOT / "ava-theme.override.yml").read_text()
    mount = "./themes/ava:/opt/keycloak/themes/ava:ro"
    assert mount in override
    assert "COPY --chown=1000:0 themes/ava /opt/keycloak/themes/ava" in (ROOT / "Dockerfile").read_text()
