"""Read-only structural checks; does not replace WordPress block/editor validation."""
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
theme = json.loads((root / 'theme.json').read_text(encoding='utf-8-sig'))
issues = []
files = list(root.glob('templates/*.html')) + list(root.glob('parts/*.html')) + list(root.glob('patterns/*.php'))
slugs = set()
for path in root.glob('patterns/*.php'):
    found = re.search(r'\* Slug: ([\w/-]+)', path.read_text(encoding='utf-8-sig'))
    if found:
        slugs.add(found.group(1))
for path in files:
    source = path.read_text(encoding='utf-8-sig')
    stack = []
    for comment in re.finditer(r'<!--\s*(/?)wp:([\w/-]+)(.*?)-->', source, re.S):
        closing, block, tail = comment.groups()
        tail = tail.strip()
        if closing:
            if not stack or stack.pop() != block:
                issues.append(f'{path.name}: mismatched closing block {block}')
            continue
        singleton = tail.endswith('/')
        if singleton:
            tail = tail[:-1].strip()
        attrs = {}
        if tail:
            try:
                attrs = json.loads(tail)
            except json.JSONDecodeError:
                issues.append(f'{path.name}: invalid JSON on {block}')
        if block == 'pattern' and attrs.get('slug') not in slugs:
            issues.append(f'{path.name}: missing pattern {attrs.get("slug")}')
        if block == 'template-part' and not (root / 'parts' / f'{attrs.get("slug")}.html').exists():
            issues.append(f'{path.name}: missing template part {attrs.get("slug")}')
        if not singleton:
            stack.append(block)
    if stack:
        issues.append(f'{path.name}: unclosed blocks {stack}')
    for asset in re.findall(r"get_theme_file_uri\(\s*'([^']+)'", source):
        if not (root / asset).is_file():
            issues.append(f'{path.name}: missing asset {asset}')
for template in theme.get('customTemplates', []):
    if not (root / 'templates' / f'{template["name"]}.html').exists():
        issues.append(f'Missing registered custom template {template["name"]}')
for required in ['style.css', 'templates/index.html']:
    if not (root / required).is_file():
        issues.append(f'Missing required theme file {required}')
if issues:
    print('\n'.join(issues))
    sys.exit(1)
print(f'{len(files)} template/pattern files: balanced block comments, valid JSON attributes, resolved pattern/part/asset references. theme.json and required files valid.')
print('PHP lint, WordPress block serialization, runtime rendering and editor behavior are not covered by this check.')
