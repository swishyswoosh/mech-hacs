"""Sync a committed Mech shared-code snapshot without overwriting local edits."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tempfile

TREES = ('app', 'core', 'web', 'licenses')
FILES = ('service/catalogs.ts', 'THIRD_PARTY_NOTICES.md')
EXCLUDED = {'node_modules', 'dist', 'build', '__pycache__', '.venv', '.pytest_cache', '.DS_Store'}
MANIFEST = 'shared-source.json'


def managed(name):
    p = PurePosixPath(name)
    return (not p.is_absolute() and '..' not in p.parts and str(p) == name
            and not any(part in EXCLUDED for part in p.parts)
            and name != 'web/README.md'
            and (name in FILES or (len(p.parts) > 1 and p.parts[0] in TREES)))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def no_symlinks(root, name):
    path = root
    for part in PurePosixPath(name).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f'Symlink cannot be synchronized: {name}')
    return path


def snapshot(source):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=source)
    if Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve() != source:
        raise ValueError('Source must be the Mech repository root')
    if git('status', '--porcelain=v1', '--untracked-files=all', '--', *TREES, *FILES):
        raise ValueError('Shared source has uncommitted changes; commit them before syncing')
    commit = git('rev-parse', 'HEAD').decode().strip()
    entries = []
    for record in git('ls-tree', '-rz', commit).split(b'\0'):
        if not record:
            continue
        metadata, raw_name = record.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        name = raw_name.decode()
        if name in TREES or managed(name):
            if mode not in {'100644', '100755'} or kind != 'blob':
                raise ValueError(f'Symlink or gitlink cannot be synchronized: {name}')
            if managed(name):
                entries.append((name, oid))
    if not entries:
        raise ValueError('No shared source found')
    # Read Git blobs directly: archive export-ignore/subst attributes must not
    # silently omit or rewrite committed source behind its recorded provenance.
    blobs = io.BytesIO(subprocess.check_output(
        ['git', 'cat-file', '--batch'], cwd=source,
        input=''.join(oid + '\n' for _, oid in entries).encode()))
    content = {}
    for name, oid in entries:
        header = blobs.readline().decode().split()
        if len(header) != 3 or header[:2] != [oid, 'blob']:
            raise ValueError(f'Cannot read committed source: {name}')
        data = blobs.read(int(header[2])); blobs.read(1)
        if any(part.startswith('.env') for part in PurePosixPath(name).parts):
            raise ValueError(f'Private environment file: {name}')
        if name == 'web/package.json':
            package = json.loads(data)
            package['scripts'] = {k: v for k, v in package.get('scripts', {}).items() if k in {'dev', 'build'}}
            data = (json.dumps(package, indent=2) + '\n').encode()
        content[name] = data
    return commit, content


def sync(source, target, *, check=False):
    source, target = Path(source).resolve(), Path(target).absolute()
    if target.is_symlink() or target.resolve() == source:
        raise ValueError('Destination must be a separate directory without a symlink')
    commit, content = snapshot(source)
    manifest_path = no_symlinks(target, MANIFEST)
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if old is not None and (old.get('schema') != 1 or not isinstance(old.get('files'), dict)):
        raise ValueError('Unsupported shared-source manifest')
    previous = old['files'] if old else {}
    for name in previous:
        if not managed(name):
            raise ValueError(f'Invalid managed path in manifest: {name}')
    existing = set()
    for tree in TREES:
        directory = no_symlinks(target, tree)
        if directory.exists():
            for p in directory.rglob('*'):
                name = p.relative_to(target).as_posix()
                if managed(name) and (p.is_file() or p.is_symlink()):
                    no_symlinks(target, name)
                    existing.add(name)
    for name in FILES:
        if no_symlinks(target, name).exists():
            existing.add(name)
    # Validate the entire plan before writing any destination file.
    for name in set(previous) | set(content) | existing:
        p = no_symlinks(target, name)
        actual = digest(p.read_bytes()) if p.is_file() else None
        if name in previous:
            if actual != previous[name]:
                raise ValueError(f'Destination conflict: {name}; preserve or reconcile the local edit first')
        elif p.exists() and (name not in content or actual != digest(content[name])):
            raise ValueError(f'Destination conflict: unmanaged file {name}')
    manifest = {'schema': 1, 'repository': 'mech', 'commit': commit,
                'files': {n: digest(data) for n, data in sorted(content.items())}}
    changed = old != manifest or any(n not in existing for n in content)
    if check:
        if changed:
            raise ValueError('Shared snapshot is out of date; run npm run sync:shared')
        return manifest
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='shared-sync-', dir=target) as temporary:
        stage = Path(temporary)
        for name, data in content.items():
            p = stage / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
        for name in sorted(set(previous) - set(content)):
            (target / name).unlink()
        for name in content:
            p = target / name; p.parent.mkdir(parents=True, exist_ok=True)
            (stage / name).replace(p)
        staged_manifest = stage / MANIFEST
        staged_manifest.write_text(json.dumps(manifest, indent=2) + '\n')
        staged_manifest.replace(manifest_path)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2] / 'mech')
    parser.add_argument('--check', action='store_true', help='Verify without changing files')
    args = parser.parse_args()
    try:
        result = sync(args.source, Path(__file__).resolve().parents[1], check=args.check)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{error}\n')
    print(f"Shared source {'verified' if args.check else 'synchronized'}: {result['commit']} ({len(result['files'])} files)")
