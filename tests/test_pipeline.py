import fcntl
import json
from pathlib import Path
import subprocess
import sys

import pytest
import yaml
from build123d import import_step
from pydantic import ValidationError
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
    second = run(first_dir / 'parameters.yaml', tmp_path, 'Increase height for clearance', {'height': 45})
    record = json.loads((Path(second['directory']) / 'record.json').read_text())
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
    with pytest.raises(ValueError, match='export failed'): run(EXAMPLE, tmp_path, 'fail export')
    assert not list(tmp_path.glob("revision-*"))
    assert not list(tmp_path.glob(".building-*"))


def test_lock_prevents_concurrent_revision(tmp_path):
    with (tmp_path / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(ValueError, match='project lock'): run(EXAMPLE, tmp_path, 'concurrent')
    assert run(EXAMPLE, tmp_path, 'Lock released')['revision']


def test_json_cli_failure_is_machine_readable(tmp_path):
    proc = subprocess.run([sys.executable, '-m', 'openengineer.cli', '--json'], input=json.dumps({
        'input': str(EXAMPLE), 'output': str(tmp_path), 'reason': 'Invalid change', 'overrides': {'height': -1}
    }), text=True, capture_output=True)
    assert proc.returncode == 1
    assert json.loads(proc.stdout)['ok'] is False
    assert not list(tmp_path.glob("revision-*"))
    assert not list(tmp_path.glob(".building-*"))
