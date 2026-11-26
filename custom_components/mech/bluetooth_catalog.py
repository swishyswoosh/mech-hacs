"""Detached semantic admission from controller-generated catalog data."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path

DATA = json.loads(Path(__file__).with_name('catalog_data.json').read_text())
MOTION_UNAVAILABLE = DATA['motion_unavailable']
CHANNELS = DATA['light_channels']
WIRE_ORDER = [0, 1, 2, 6, 3, 4, 5, 7]


def _load(preferences, key):
    if preferences is None:
        return None
    return preferences.load(key) if hasattr(preferences, 'load') else preferences.get(key)


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'Expected integer {minimum}..{maximum}')
    return value


def _light(values, selected):
    if not isinstance(values, list) or len(values) != 8 or not isinstance(selected, list) or len(selected) != 8 or any(type(v) is not bool for v in selected):
        raise ValueError('Invalid light channels')
    for value in values:
        _integer(value, 0, 255)
    mask = sum(1 << bit for bit, index in enumerate(WIRE_ORDER) if selected[index])
    if not mask:
        raise ValueError('Select at least one light channel')
    return (26, 14, mask.to_bytes(2, 'big') + bytes(values[i] for i in WIRE_ORDER if selected[i]))


def _presets(preferences):
    raw = _load(preferences, 'lightPresets.v1')
    if raw is not None:
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('presets'), list):
            raise ValueError('Unsupported light preset library')
        presets = data['presets']
    else:
        raw = _load(preferences, 'lightPreset')
        if raw is None:
            return []
        old = json.loads(raw)
        presets = [dict(id='legacy-light-preset', name=_load(preferences, 'lightPresetName') or 'My lights', values=old.get('values'), selected=old.get('selected'))]
    ids, names, result = set(), set(), []
    for item in presets:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id'] or item['id'] in ids:
            raise ValueError('Invalid preset identity')
        name = item.get('name')
        if not isinstance(name, str) or not name.strip() or name.strip().lower() in names:
            raise ValueError('Invalid or duplicate preset name')
        _light(item.get('values'), item.get('selected'))
        ids.add(item['id'])
        names.add(name.strip().lower())
        result.append({**item, 'name': name.strip()})
    return result


def compile_recipe(recipe):
    if not isinstance(recipe, dict) or set(recipe) - {'version', 'name', 'frames'} or recipe.get('version') != 1 or not isinstance(recipe.get('name'), str) or not recipe['name'].strip() or len(recipe['name']) > 120:
        raise ValueError('Expected version 1, name and light frames')
    frames = recipe.get('frames')
    if not isinstance(frames, list) or not 1 <= len(frames) <= 99:
        raise ValueError('A light protocol requires 1..99 frames')
    payload, previous, duration = bytearray([0, 0]), -1, 0
    for frame in frames:
        if not isinstance(frame, dict) or set(frame) != {'atMs', 'controls', 'transitionMs'}:
            raise ValueError('Only inline LED frame fields are supported')
        at = _integer(frame['atMs'], 0, 65535)
        transition = _integer(frame['transitionMs'], 80, 65535)
        if at <= previous or (previous == -1 and at != 0) or at + transition > 65535:
            raise ValueError('Invalid light frame timing')
        controls = frame['controls']
        if not isinstance(controls, list) or len(controls) != 8:
            raise ValueError('Exactly eight raw LED controls required')
        payload.extend([255, at >> 8, at & 255, 15])
        payload.extend(_integer(value, 0, 255) for value in controls)
        payload.extend(transition.to_bytes(2, 'big'))
        previous, duration = at, max(duration, at + transition)
    payload.append(254)
    if len(payload) > 1000:
        raise ValueError('Encoded LED schedule exceeds 1000 bytes')
    return (23, 26, bytes(payload)), duration


def _recipe(preferences):
    raw = _load(preferences, 'device.light-recipe.v1')
    if raw is not None and len(raw) > 50000:
        raise ValueError('Light protocol exceeds 50 KB')
    recipe = json.loads(raw) if raw is not None else deepcopy(DATA['recipe'])
    compile_recipe(recipe)
    return recipe


def catalog(kind, preferences=None):
    if kind not in DATA['catalogs']:
        raise ValueError('Unknown catalog kind')
    result = deepcopy(DATA['catalogs'][kind])
    if kind == 'light_presets':
        existing = {item['id'] for item in result['items']}
        result['items'].extend(dict(id=p['id'], name=p['name'], available=True, effects=['lights'], required_resources=['lights'], completion='ack') for p in _presets(preferences) if p['id'] not in existing)
    elif kind == 'protocols':
        recipe = _recipe(preferences)
        result['items'][0].update(name=recipe['name'], duration_ms=compile_recipe(recipe)[1])
    elif kind == 'paths' and _load(preferences, 'automation.path.v1') is not None:
        result['items'] = [dict(id='path-saved', name='Saved path', available=False, effects=['motion'], required_resources=['drive', 'stance'], completion='ack', reason=MOTION_UNAVAILABLE)]
    return result


@dataclass(frozen=True)
class PreparedAction:
    action: str
    _parameters_json: str
    command: tuple[int, int, bytes]
    duration_ms: int = 0

    @property
    def parameters(self):
        """Each reader gets a copy; an admitted wire plan cannot be mutated."""
        return json.loads(self._parameters_json)


def prepare(action, parameters, preferences=None):
    if not isinstance(parameters, dict):
        raise ValueError('Action parameters must be an object')
    duration = 0
    if action == 'sound.play':
        if set(parameters) != {'sound_id'} or not isinstance(parameters['sound_id'], str):
            raise ValueError('A catalog sound_id is required')
        item = next((item for item in DATA['catalogs']['sounds']['items'] if item['id'] == parameters['sound_id']), None)
        if item is None:
            raise ValueError('Unknown sound')
        command = (26, 7, item['sector'].to_bytes(2, 'big') + b'\x00')
        normalized = {'sound_id': item['id']}
    elif action == 'lights.apply':
        if set(parameters) not in ({'preset_id'}, {'settings'}):
            raise ValueError('Choose exactly one light preset_id or settings object')
        if 'preset_id' in parameters:
            identifier = parameters['preset_id']
            if not isinstance(identifier, str):
                raise ValueError('Light preset_id must be a string')
            builtin = DATA['presets'].get(identifier)
            if builtin:
                command = (builtin['did'], builtin['cid'], bytes(builtin['data']))
            else:
                item = next((item for item in _presets(preferences) if item['id'] == identifier), None)
                if item is None:
                    raise ValueError('Unknown light preset')
                command = _light(item['values'], item['selected'])
        else:
            settings = parameters['settings']
            if not isinstance(settings, dict) or set(settings) - set(CHANNELS):
                raise ValueError('Unknown light channel')
            command = _light([settings.get(key, 0) for key in CHANNELS], [key in settings for key in CHANNELS])
        mask, values = int.from_bytes(command[2][:2], 'big'), iter(command[2][2:])
        normalized = {**({'preset_id': parameters['preset_id']} if 'preset_id' in parameters else {}), 'resolved_settings': {CHANNELS[index]: next(values) for bit, index in enumerate(WIRE_ORDER) if mask & (1 << bit)}}
    elif action == 'protocol.run':
        if set(parameters) - {'protocol_id', 'recipe'} or parameters.get('protocol_id') != 'protocol-device-lights':
            raise ValueError('Only the vetted light-only protocol is supported')
        recipe_preferences = preferences
        if 'recipe' in parameters:
            recipe_preferences = {'device.light-recipe.v1': json.dumps(parameters['recipe'])}
        recipe = _recipe(recipe_preferences)
        command, duration = compile_recipe(recipe)
        normalized = {'protocol_id': 'protocol-device-lights', 'resolved_recipe': recipe}
    elif action in ('animation.play', 'path.run') or any(word in action.lower() for word in ('drive', 'dome', 'stance', 'motion', 'ram')):
        raise ValueError(MOTION_UNAVAILABLE)
    else:
        raise ValueError('Unknown semantic action')
    return PreparedAction(action, json.dumps(normalized, sort_keys=True), command, duration)
