from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from src.core.onyx_client import OnyxClientError
from src.core.onyx_shadow_mode import OnyxShadowModeRunner, observation_hash


class AgentStub:
    def __init__(self, result=None, error=None):
        self.result = result or {'answer': 'Время заезда — 14:00.', 'grounded': True,
            'citations': [{'source_id': 1}], 'execution_source': 'onyx_live',
            'grounding_verification': 'scoped_citations_only', 'recommended_next_step': 'answer_provided'}
        self.error = error

    def answer_query(self, **kwargs):
        if self.error:
            raise self.error
        return deepcopy(self.result)


@pytest.fixture
def runner(tmp_path):
    return OnyxShadowModeRunner(db_path=str(tmp_path/'shadow.db'), agent_runner=AgentStub())


def observe(runner):
    return runner.process_shadow_query(business_id=1, query='Во сколько заезд?', legacy_response='Старый ответ не эталон.')


def reviewed_batch(runner):
    now = datetime.now(timezone.utc)
    rows = []
    for i in range(20):
        row = observe(runner)
        row['query'] = f'Operator validated fixture question {i}'
        row['timestamp'] = (now-timedelta(hours=25-i)).isoformat()
        if i == 19:
            row['timestamp'] = (now-timedelta(minutes=1)).isoformat()
        digest = observation_hash(row)
        row['review'] = {'reviewer': 'test-operator', 'evidence_reference': f'fixture:answer-{i}',
                         'observation_hash': digest, 'accuracy_score': 1.0}
        rows.append(row)
    evidence = {'business_id': 1, 'reviewer': 'test-operator', 'evidence_reference': 'fixture:separate-security-action-report',
                'verified_at': now.isoformat(), 'observation_hashes': sorted(observation_hash(r) for r in rows),
                'critical_action_cases': 10, 'critical_action_passed': 10, 'security_cases': 10,
                'cross_tenant_incidents': 0}
    return rows, evidence


def test_citations_are_not_accuracy_or_security_evidence(runner):
    result = observe(runner)
    assert result['grounded'] is True
    assert result['accuracy_score'] is None
    assert result['critical_action_accuracy'] is None
    assert result['cross_tenant_incident'] is None
    report = runner.evaluate_shadow_metrics([result])
    assert report['metrics']['rag_accuracy_pct'] is None
    assert report['metrics']['critical_action_accuracy_pct'] is None
    assert report['metrics']['cross_tenant_incidents'] is None
    assert report['metrics']['grounded_answers_pct'] == 100
    assert report['rollout_status'] == 'BLOCKED_GAPS_DETECTED'


def test_legacy_automatic_green_metrics_are_not_trusted(runner):
    rows = [observe(runner) for _ in range(20)]
    for row in rows:
        row.update(accuracy_score=1, critical_action_accuracy=1, cross_tenant_incident=False)
    report = runner.evaluate_shadow_metrics(rows)
    assert report['reviewed_queries'] == 0
    assert not report['rollout_criteria_passed']['rag_accuracy']
    assert not report['rollout_criteria_passed']['security_isolation']
    assert not report['rollout_criteria_passed']['critical_actions']


def test_reviewed_batch_and_separate_acceptance_evidence_can_pass(runner):
    rows, evidence = reviewed_batch(runner)
    report = runner.evaluate_shadow_metrics(rows, acceptance_evidence=evidence)
    assert report['rollout_status'] == 'READY_FOR_PILOT'
    assert report['reviewed_queries'] == 20
    assert report['metrics']['critical_action_accuracy_pct'] == 100
    assert report['metrics']['cross_tenant_incidents'] == 0


@pytest.mark.parametrize('mutate', [
    lambda rows, e: rows[0].update(onyx_response='A different, unreviewed answer'),
    lambda rows, e: rows[0]['review'].update(accuracy_score=True),
    lambda rows, e: rows[0]['review'].update(accuracy_score=float('nan')),
    lambda rows, e: rows[0].update(review='malformed'),
    lambda rows, e: e.update(business_id=2),
    lambda rows, e: e.update(critical_action_cases=0),
    lambda rows, e: e.update(critical_action_passed=9),
    lambda rows, e: e.update(security_cases=0),
    lambda rows, e: e.update(cross_tenant_incidents=1),
    lambda rows, e: e.update(verified_at='2020-01-01T00:00:00Z'),
    lambda rows, e: e.update(observation_hashes=[]),
    lambda rows, e: rows[0].update(execution_source='local_keyword_simulation'),
    lambda rows, e: rows[0].update(sync_lag_sec=301),
    lambda rows, e: rows[0].update(cross_tenant_incident=True),
])
def test_incomplete_stale_or_changed_evidence_blocks(runner, mutate):
    rows, evidence = reviewed_batch(runner)
    mutate(rows, evidence)
    assert runner.evaluate_shadow_metrics(rows, acceptance_evidence=evidence)['rollout_status'] == 'BLOCKED_GAPS_DETECTED'


def test_short_or_duplicate_observations_do_not_pass_shadow_window(runner):
    rows, evidence = reviewed_batch(runner)
    assert not runner.evaluate_shadow_metrics(rows[:1], acceptance_evidence=evidence)['rollout_criteria_passed']['sample_size']
    assert not runner.evaluate_shadow_metrics([rows[0]]*20, acceptance_evidence=evidence)['rollout_criteria_passed']['sample_size']
    assert not runner.evaluate_shadow_metrics([rows[0]]*20, acceptance_evidence=evidence)['rollout_criteria_passed']['observation_window']


def test_upstream_errors_are_measured_and_not_fabricated(runner):
    runner.agent_runner = AgentStub(error=OnyxClientError('Bearer private-token', code='ONYX_NETWORK_ERROR'))
    row = observe(runner)
    assert row['error_code'] == 'ONYX_NETWORK_ERROR'
    assert row['onyx_response'] is None
    assert row['recommended_next_step'] == 'legacy_fallback'
    assert 'private-token' not in str(row)
    assert runner.evaluate_shadow_metrics([row])['rollout_status'] == 'BLOCKED_GAPS_DETECTED'


def test_detected_foreign_source_is_an_incident_not_a_success(runner):
    runner.agent_runner = AgentStub(error=OnyxClientError('scope rejected', code='ONYX_CROSS_TENANT_SOURCE'))
    row = observe(runner)
    assert row['cross_tenant_incident'] is True
    assert runner.evaluate_shadow_metrics([row])['metrics']['cross_tenant_incidents'] == 1


def test_empty_batch_is_blocked(runner):
    assert runner.evaluate_shadow_metrics([])['status'] == 'NO_DATA'
