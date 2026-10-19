import fcntl
import json
from pathlib import Path
import subprocess
import sys

import pytest
import yaml
from build123d import import_step
from pydantic import ValidationError
from openengineer.errors import EngineError
from openengineer.models import Bracket
from openengineer.geometry import build, validate
from openengineer.pipeline import run

EXAMPLE = Path(__file__).resolve().parents[1] / 'examples/mounting-bracket/dimensions.yaml'

@pytest.fixture
def data():
    return yaml.safe_load(EXAMPLE.read_text())


def test_build_modify_and_reimport_with_immutable_history(tmp_path):
    first = run(EXAMPLE, tmp_path, 'Initial dimensions')
    first_dir = Path(first['directory'])
    original = (first_dir / 'part.step').read_bytes()
    assert first['parent'] is None
    assert set(first['artifacts']) == {'step', 'parameters', 'record', 'report'}
    assert Path(first['artifacts']['report']).is_file()
    second = run(first_dir / 'parameters.yaml', tmp_path, 'Increase height for clearance', {'height': 45})
    record = json.loads((Path(second['directory']) / 'record.json').read_text())
    assert second['parent'] == first['revision']
    assert record['parent'] == first['revision']
    assert record['changes']['height']['before']['value'] == 30
    assert record['changes']['height']['after']['value'] == 45
    assert record['parameters']['height']['source'] == 'assumed'
    assert (first_dir / 'part.step').read_bytes() == original
    assert import_step(Path(second['directory']) / 'part.step').bounding_box().size.Z == pytest.approx(45)
    assert all(second['validation']['checks'].values())
    assert len(second['validation']['hole_boundary_circles_mm']) == 4


@pytest.mark.parametrize('mutation', ['missing', 'nan', 'unit', 'edge', 'overlap', 'thickness', 'unknown'])
def test_reject_bad_dimensions(data, mutation):
    if mutation == 'missing': del data['height']
    if mutation == 'nan': data['height']['value'] = float('nan')
    if mutation == 'unit': data['units'] = 'inch'
    if mutation == 'edge': data['holes'][0]['y']['value'] = 5
    if mutation == 'overlap': data['holes'][1] = data['holes'][0]
    if mutation == 'thickness': data['thickness']['value'] = 50
    if mutation == 'unknown': data['lenght'] = 80
    with pytest.raises(ValidationError): Bracket.model_validate(data)


def test_validation_detects_wrong_hole_positions_even_when_volume_matches(data):
    spec = Bracket.model_validate(data)
    data['holes'][0]['x']['value'] = 25
    wrong_part = build(Bracket.model_validate(data))
    with pytest.raises(ValueError, match='Missing hole boundary'): validate(wrong_part, spec)


def test_failed_export_does_not_commit_revision(tmp_path, monkeypatch):
    monkeypatch.setattr('openengineer.pipeline.export_step', lambda *a: False)
    with pytest.raises(EngineError, match='export failed') as caught:
        run(EXAMPLE, tmp_path, 'fail export')
    assert caught.value.code == 'EXPORT'
    assert not list(tmp_path.glob("revision-*"))
    assert not list(tmp_path.glob(".building-*"))


def test_failed_step_reimport_does_not_commit_revision(tmp_path, monkeypatch):
    def broken_import(*_args):
        raise RuntimeError('no reader')
    monkeypatch.setattr('openengineer.pipeline.import_step', broken_import)
    with pytest.raises(EngineError, match='reimport failed') as caught:
        run(EXAMPLE, tmp_path, 'fail reimport')
    assert caught.value.code == 'GEOMETRY'
    assert not list(tmp_path.glob("revision-*"))
    assert not list(tmp_path.glob(".building-*"))


def test_lock_prevents_concurrent_revision(tmp_path):
    with (tmp_path / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(EngineError, match='project lock') as caught:
            run(EXAMPLE, tmp_path, 'concurrent')
        assert caught.value.code == 'LOCK'
    assert run(EXAMPLE, tmp_path, 'Lock released')['revision']


def test_empty_reason_is_rejected(tmp_path):
    with pytest.raises(EngineError, match='reason is required') as caught:
        run(EXAMPLE, tmp_path, '   ')
    assert caught.value.code == 'VALIDATION'


def test_oversized_input_is_rejected(tmp_path):
    oversized = tmp_path / 'oversized.yaml'
    oversized.write_text('a' * 1_000_001)
    with pytest.raises(EngineError, match='exceeds 1 MB') as caught:
        run(oversized, tmp_path / 'output', 'too large')
    assert caught.value.code == 'VALIDATION'
    assert not (tmp_path / 'output').exists()


def test_json_cli_failure_is_machine_readable(tmp_path):
    proc = subprocess.run([sys.executable, '-m', 'openengineer.cli', '--json'], input=json.dumps({
        'input': str(EXAMPLE), 'output': str(tmp_path), 'reason': 'Invalid change', 'overrides': {'height': -1}
    }), text=True, capture_output=True)
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload['ok'] is False
    assert payload['code'] == 'VALIDATION'
    assert not list(tmp_path.glob("revision-*"))
    assert not list(tmp_path.glob(".building-*"))


def test_json_cli_rejects_unknown_fields(tmp_path):
    proc = subprocess.run([sys.executable, '-m', 'openengineer.cli', '--json'], input=json.dumps({
        'input': str(EXAMPLE), 'output': str(tmp_path), 'reason': 'Unknown field', 'unexpected': 1
    }), text=True, capture_output=True)
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload['code'] == 'VALIDATION'
    assert 'Unknown request fields' in payload['error']


def test_classic_cli_builds_and_overrides(tmp_path):
    proc = subprocess.run([
        sys.executable, '-m', 'openengineer.cli',
        '--input', str(EXAMPLE), '--output', str(tmp_path),
        '--reason', 'CLI build', '--set', 'height=45',
    ], text=True, capture_output=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload['ok'] is True
    assert payload['result']['validation']['bounding_mm'] == [80, 40, 45]
    assert payload['result']['parent'] is None
