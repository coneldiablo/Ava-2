"""Regression for the native enrollment failure reproduced in Keycloak 26.7."""
import json
from pathlib import Path


def test_invitation_identity_is_preserved_without_exposing_it_to_customer():
    realm = json.loads((Path(__file__).parents[1] / 'deploy/keycloak/ava-realm.json').read_text())
    component, = realm['components']['org.keycloak.userprofile.UserProfileProvider']
    profile = json.loads(component['config']['kc.user.profile.config'][0])
    fields = {field['name']: field for field in profile['attributes']}
    assert fields['avaUserId']['permissions'] == {'view': ['admin'], 'edit': ['admin']}
    assert fields['avaUserId']['validations']['length'] == {'min': 36, 'max': 36}
    assert fields['avaUserId']['multivalued'] is False
    assert 'required' not in fields['firstName']
    assert 'required' not in fields['lastName']
    assert realm['registrationAllowed'] is False
    assert realm['resetPasswordAllowed'] is False
