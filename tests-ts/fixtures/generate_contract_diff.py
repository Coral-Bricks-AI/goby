#!/usr/bin/env python3
"""Regenerate local reference receipts; no pytest, providers, network, or model calls.

Run: python3 tests-ts/fixtures/generate_contract_diff.py
Extracts only pure contract/diff tests from test_harness.py and records each
reference call, including snapshots before mutating dedupe calls.
"""
import ast
import dataclasses
import importlib.util
import json
import math
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

F = load('reference_contract', 'reference/python/src/goby/core/contract.py')
D = load('reference_diff', 'reference/python/src/goby/core/diff.py')

def encode(value):
    if isinstance(value, F.Finding):
        return {'$finding': encode(dataclasses.asdict(value))}
    if dataclasses.is_dataclass(value):
        return encode(dataclasses.asdict(value))
    if isinstance(value, float) and not math.isfinite(value):
        return {'$number': str(value)}
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value

calls = []
case = ''
class Recorder:
    def __init__(self, module, namespace):
        self.module, self.namespace = module, namespace
    def __getattr__(self, name):
        value = getattr(self.module, name)
        if not callable(value):
            return value
        def call(*args, **kwargs):
            receipt = {'case': case, 'namespace': self.namespace, 'name': name,
                       'args': encode(args), 'kwargs': encode(kwargs)}
            try:
                result = value(*args, **kwargs)
                receipt['result'] = encode(result)
                return result
            except (ValueError, OverflowError, TypeError) as error:
                receipt['error'] = type(error).__name__
                raise
            finally:
                calls.append(receipt)
        return call

source = ast.parse((ROOT / 'reference/python/tests/test_harness.py').read_text())
prefixes = ('test_parse_', 'test_coerce_', 'test_bare_', 'test_select_', 'test_clamp_', 'test_line_in_',
            'test_resolve_diff_', 'test_rekey_', 'test_dedupe_', 'test_fid_',
            'test_keep_path_', 'test_finding_', 'test_thread_spans_',
            'test_system_prompt_', 'test_split_', 'test_plan_',
            'test_build_user_prompt_', 'test_retraction_', 'test_prompt_allows_',
            'test_format_thread_')
selected = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name.startswith(prefixes)]
helpers = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('_thread', '_parse_one')]
constants = [n for n in source.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'DIFF' for t in n.targets)]
env = {'F': Recorder(F, 'contract'), 'difflines': Recorder(D, 'diff'), 'json': json}
exec(compile(ast.Module(body=helpers + constants + selected, type_ignores=[]), 'tests/test_harness.py', 'exec'), env)
for node in selected:
    case = node.name
    env[node.name]()

case = 'additional_parser_edges'
base = {'path': 'a.py', 'line': 3, 'title': 'T', 'severity': 'low'}
texts = ['', '[]', 'I found []', '[1]', '```json\nnull\n```',
         '```json\n[]\n```\n```json\n{bad}\n```',
         '```json\n[1, ' + json.dumps(base) + ']\n```',
         '[1] ' * 50 + json.dumps([base]),
         '```JSON\n' + json.dumps([base]) + '\n```']
for field, values in {
    'line': [True, None, '3', -1, 0, 1.9, float('nan'), float('inf')],
    'end_line': [True, '9', 1, 9.9, 10**44, float('nan'), float('inf')],
    'severity': ['blocker', 'minor', 'info', 'constructor', None, {}, 12],
    'path': ['  b/x.py  ', '__proto__', '\ufeffx.py\ufeff', '\x1cx.py\x1c'],
}.items():
    for value in values:
        texts.append('```json\n' + json.dumps([{**base, field: value}]) + '\n```')
for text in texts:
    for strict in [False, True]:
        try:
            env['F'].parse_findings(text, strict=strict)
        except (ValueError, OverflowError):
            pass

case = 'additional_retraction_boundaries'
for text in ['éno bug.', 'énot reporting as a real issue.', 'é no bug.', 'This is no bug here.', '漢no issue.']:
    env['F']._retraction_at_verdict(text)

case = 'additional_selection_unknown_severity'
env['F'].select_findings([F.Finding('a', 1, 'constructor', 'unknown'), F.Finding('a', 2, 'high', 'high')], 1)

case = 'additional_similarity_edges'
rng = random.Random(1977)
pairs = [('tide', 'diet'), ('diet', 'tide'), ('', ''), ('***A!***', 'a'),
         ('é₂漢 😀', 'É₂漢'), ('a' * 199 + 'b', 'b' + 'a' * 199),
         ('b' + 'a' * 199, 'a' * 199 + 'b'), ('x' + 'a' * 300, 'y' + 'a' * 300)]
for size in [8, 40, 199, 200, 300]:
    for _ in range(20):
        pairs.append((''.join(rng.choices('abcde ', k=size)), ''.join(rng.choices('abcde ', k=size))))
for a, b in pairs:
    env['F']._claim_similarity(a, b)

case = 'additional_thread_edges'
for thread in [{}, {'path': 'a'}, {'line': 7}, {'line': 7, 'original_line': None},
               {'line': 7, 'start_line': 12}, {'line': 84, 'start_line': 80, 'original_line': 14, 'original_start_line': 9},
               {'line': '84', 'marker_start': '9', 'marker_end': '14'},
               {'line': 12, 'marker_start': 9, 'marker_end': 14}]:
    env['F'].thread_spans(thread)
    env['F'].format_thread_position(thread)

case = 'additional_diff_edges'
for text in ['@@ -1 +1 @@\n', '+++ b/__proto__\n@@ -1 +1 @@',
             '+++ b/x\n@@ -1 +2 @@\ndiff --git a/y b/y\n@@ -1 +9 @@',
             '+++ b/x\r@@ -1 +2,0 @@\r+++ b/y\u2028@@ -0,0 +1,3 @@']:
    env['difflines'].parse_hunks(text)

case = 'additional_prompt_edges'
for intent in [None, {}, {'title': 't', 'body': '   '}, {'title': '', 'body': 'body'}, {'body': '😀' * 4100}]:
    env['F'].build_user_prompt('d', ' context ', ['open'], ['resolved'], intent, ' tree ')

out = {'source': 'Pure tests extracted from tests/test_harness.py, plus deterministic edge probes',
       'python_tests': len(selected), 'system_prompt': F.SYSTEM_PROMPT, 'calls': calls}
path = ROOT / 'tests-ts/fixtures/contract-diff.json'
path.write_text(json.dumps(out, ensure_ascii=True, indent=2) + '\n')
print(f'{len(selected)} original Python tests passed; wrote {len(calls)} reference calls to {path.relative_to(ROOT)}')
