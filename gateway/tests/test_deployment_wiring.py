import importlib.util
import json
from pathlib import Path

import pytest
from artemis.preflight import validate

# infra/ sits at the repository root, beside gateway/, so walk up until it is found
# rather than assuming a fixed depth: the same test file is run from either directory.
_here = Path(__file__).resolve()
_script = next((d / 'infra/prepare-vercel.py' for d in _here.parents if (d / 'infra/prepare-vercel.py').is_file()), None)
if _script is None:
    raise FileNotFoundError('infra/prepare-vercel.py not found above ' + str(_here))

spec = importlib.util.spec_from_file_location('prepare_vercel', _script)
wiring = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wiring)


def test_rewrites_precede_existing_catchall_and_preserve_other_configuration(tmp_path):
    original = {'headers': [{'source': '/foo', 'headers': []}], 'rewrites': [
        {'source': '/api/(.*)', 'destination': '/api/index'},
        {'source': '/((?!api/).*)', 'destination': '/index.html'}]}
    target = tmp_path / 'vercel.json'; target.write_text(json.dumps(original))
    wiring.prepare('https://gateway.example/', tmp_path)
    result = json.loads(target.read_text())
    assert result['headers'] == original['headers']
    assert result['rewrites'] == [
        {'source': '/api/:path*', 'destination': 'https://gateway.example/api/:path*'},
        {'source': '/v1/:path*', 'destination': 'https://gateway.example/v1/:path*'},
        original['rewrites'][1]]
    wiring.prepare('https://other-gateway.example', tmp_path)
    assert len(json.loads(target.read_text())['rewrites']) == 3


@pytest.mark.parametrize('url', ['http://gateway.example', 'https://user:secret@gateway.example', 'https://gateway.example/path',
    'https://gateway.example?token=secret', 'https://cutline-industries.studio', 'https://cutline-industries.vercel.app'])
def test_invalid_or_self_referential_gateway_does_not_change_config(tmp_path, url):
    target = tmp_path / 'vercel.json'; target.write_text('{}')
    with pytest.raises(ValueError): wiring.prepare(url, tmp_path)
    assert target.read_text() == '{}'


def environment():
    return {'DATABASE_URL': 'postgresql://test:test@db/artemis', 'ARTEMIS_COOKIE_SECURE': '1',
        'ARTEMIS_ALLOWED_ORIGINS': 'https://cutline-industries.studio', 'VLLM_BASE_URL': 'http://private-model:8000/v1', 'VLLM_MODEL': 'artemis'}


def test_preflight_accepts_complete_configuration_and_does_not_include_secret_in_errors():
    env = environment(); assert validate(env) == []
    env.update(DATABASE_URL='sqlite:SECRET_PASSWORD', ARTEMIS_COOKIE_SECURE='0', ARTEMIS_ALLOWED_ORIGINS='http://public.example')
    issues = validate(env)
    assert len(issues) == 3
    assert 'SECRET_PASSWORD' not in '\n'.join(issues)


def test_accounts_only_setup_requires_explicit_untrained_choice():
    env = environment(); del env['VLLM_BASE_URL']; del env['VLLM_MODEL']
    assert validate(env)
    assert validate(env, allow_untrained=True) == []
