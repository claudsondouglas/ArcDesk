#!/usr/bin/env python3

import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time


SNAPSHOT_NAME = 'state.json'


def _safe_session_id(value):
    session_id = re.sub(r'[^A-Za-z0-9._-]', '_', str(value or 'unknown'))
    return session_id[:128] or 'unknown'


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _limit(raw):
    if not isinstance(raw, dict):
        return None
    used = _number(raw.get('used_percentage'))
    resets_at = _number(raw.get('resets_at'))
    if used is None:
        return None
    return {'used_percentage': used, 'resets_at': resets_at}


def _stored_limit(raw, fallback_updated_at=None):
    limit = _limit(raw)
    if limit is None:
        return None
    updated_at = _number(raw.get('updated_at'))
    limit['updated_at'] = updated_at if updated_at is not None else fallback_updated_at
    return limit


def _read_state(path):
    try:
        with path.open('r', encoding='utf-8') as source:
            state = json.load(source)
        return state if isinstance(state, dict) else None
    except (OSError, ValueError):
        return None


def _legacy_state(cache_dir):
    """Recupera o valor valido mais recente de cada campo do cache antigo."""
    candidates = []
    for path in cache_dir.glob('*.json'):
        if path.name == SNAPSHOT_NAME:
            continue
        try:
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            pass

    recovered = None
    for modified_at, path in sorted(
            candidates, key=lambda item: item[0], reverse=True):
        candidate = _read_state(path)
        if candidate is None:
            continue
        captured_at = _number(candidate.get('captured_at')) or modified_at
        if recovered is None:
            recovered = {
                'captured_at': captured_at,
                'session_id': candidate.get('session_id'),
                'model': candidate.get('model'),
                'context_window': {},
                'rate_limits': {},
            }

        context = candidate.get('context_window')
        context = context if isinstance(context, dict) else {}
        if _number(recovered['context_window'].get('used_percentage')) is None:
            used = _number(context.get('used_percentage'))
            if used is not None:
                recovered['context_window'] = {
                    'used_percentage': used,
                    'remaining_percentage': _number(context.get('remaining_percentage')),
                    'updated_at': _number(context.get('updated_at')) or captured_at,
                }

        limits = candidate.get('rate_limits')
        limits = limits if isinstance(limits, dict) else {}
        for name in ('five_hour', 'seven_day'):
            if recovered['rate_limits'].get(name) is not None:
                continue
            recovered['rate_limits'][name] = _stored_limit(limits.get(name), captured_at)

    return recovered


def _merge_state(previous, payload, captured_at):
    previous = previous if isinstance(previous, dict) else {}
    previous_model = previous.get('model')
    previous_model = previous_model if isinstance(previous_model, dict) else {}
    incoming_model = payload.get('model')
    incoming_model = incoming_model if isinstance(incoming_model, dict) else {}

    previous_context = previous.get('context_window')
    previous_context = previous_context if isinstance(previous_context, dict) else {}
    incoming_context = payload.get('context_window')
    incoming_context = incoming_context if isinstance(incoming_context, dict) else {}
    context_used = _number(incoming_context.get('used_percentage'))
    if context_used is not None:
        context = {
            'used_percentage': context_used,
            'remaining_percentage': _number(incoming_context.get('remaining_percentage')),
            'updated_at': captured_at,
        }
    else:
        context = {
            'used_percentage': _number(previous_context.get('used_percentage')),
            'remaining_percentage': _number(previous_context.get('remaining_percentage')),
            'updated_at': _number(previous_context.get('updated_at')),
        }

    previous_limits = previous.get('rate_limits')
    previous_limits = previous_limits if isinstance(previous_limits, dict) else {}
    incoming_limits = payload.get('rate_limits')
    incoming_limits = incoming_limits if isinstance(incoming_limits, dict) else {}
    limits = {}
    for name in ('five_hour', 'seven_day'):
        fresh = _limit(incoming_limits.get(name))
        if fresh is not None:
            fresh['updated_at'] = captured_at
            limits[name] = fresh
        else:
            limits[name] = _stored_limit(
                previous_limits.get(name), _number(previous.get('captured_at')))

    return {
        'version': 2,
        'captured_at': captured_at,
        'session_id': _safe_session_id(payload.get('session_id')),
        'model': {
            'id': incoming_model.get('id') or previous_model.get('id'),
            'display_name': incoming_model.get('display_name') or
                previous_model.get('display_name'),
        },
        'context_window': context,
        'rate_limits': limits,
    }


def _write_atomic(path, state, cache_dir, prefix):
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=prefix, suffix='.tmp', dir=cache_dir)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(state, output, ensure_ascii=False, separators=(',', ':'))
            output.write('\n')
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.unlink(temporary_path)
        except OSError:
            pass
        raise


def _status_text(state):
    model = state.get('model', {}).get('display_name') or 'Claude Code'
    parts = []
    context = state.get('context_window', {}).get('used_percentage')
    session = state.get('rate_limits', {}).get('five_hour')
    weekly = state.get('rate_limits', {}).get('seven_day')
    if context is not None:
        parts.append(f'contexto {context:.0f}%')
    if session:
        parts.append(f'5h {session["used_percentage"]:.0f}%')
    if weekly:
        parts.append(f'7d {weekly["used_percentage"]:.0f}%')
    return f'[{model}]' + (f' · {" · ".join(parts)}' if parts else '')


def main():
    try:
        payload = json.load(sys.stdin)
        session_id = _safe_session_id(payload.get('session_id'))
        cache_home = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache')
        cache_dir = cache_home / 'arcdesk' / 'claude-code'
        cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(cache_dir, 0o700)

        lock_path = cache_dir / '.state.lock'
        with lock_path.open('a+', encoding='utf-8') as lock:
            os.chmod(lock_path, 0o600)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            previous = _read_state(cache_dir / SNAPSHOT_NAME)
            if previous is None:
                previous = _legacy_state(cache_dir)
            state = _merge_state(previous, payload, time.time())
            _write_atomic(cache_dir / SNAPSHOT_NAME, state, cache_dir, '.state.')
            _write_atomic(
                cache_dir / f'{session_id}.json', state, cache_dir, f'.{session_id}.')

        print(_status_text(state))
    except Exception:
        # A telemetria visual nunca deve interromper a sessão do Claude Code.
        print('[Claude Code]')


if __name__ == '__main__':
    main()
