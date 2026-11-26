"""Exercise synchronization against real local Git repositories; no network."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/sync-shared.py'


class SharedSyncTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'shared-code sync command is missing')
        spec = importlib.util.spec_from_file_location('sync_shared', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'mech'; self.source.mkdir()
        self.target = Path(self.tmp.name) / 'hacs'; self.target.mkdir()
        self.git('init', '-q'); self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.write('app/view.ts', 'first')
        self.write('web/package.json', json.dumps({'scripts': {'build':'vite build','test':'private runner'},'name':'fixture'}))
        self.write('web/README.md', 'not portable')
        self.write('android/private.txt', 'not shared')
        self.commit()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.source).decode().strip()

    def write(self, name, text):
        p=self.source/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)

    def commit(self):
        self.git('add', '.'); self.git('commit', '-qm', 'fixture')

    def sync(self, check=False):
        return self.module.sync(self.source, self.target, check=check)

    def test_provenance_portable_package_and_check(self):
        self.sync()
        manifest=json.loads((self.target/'shared-source.json').read_text())
        self.assertEqual(manifest['commit'], self.git('rev-parse', 'HEAD'))
        self.assertEqual((self.target/'app/view.ts').read_text(), 'first')
        self.assertEqual(json.loads((self.target/'web/package.json').read_text())['scripts'], {'build':'vite build'})
        self.assertFalse((self.target/'web/README.md').exists())
        self.assertFalse((self.target/'android').exists())
        self.sync(check=True)

    def test_dirty_and_untracked_shared_source_refused(self):
        self.write('app/view.ts', 'dirty')
        with self.assertRaisesRegex(ValueError, 'uncommitted'): self.sync()
        self.git('restore','app/view.ts'); self.write('app/new.ts', 'untracked')
        with self.assertRaisesRegex(ValueError, 'uncommitted'): self.sync()
        self.assertEqual(list(self.target.iterdir()), [])

    def test_target_conflict_blocks_entire_update(self):
        self.sync(); (self.target/'app/view.ts').write_text('local edit')
        self.write('app/new.ts','new'); self.commit()
        with self.assertRaisesRegex(ValueError,'conflict'): self.sync()
        self.assertFalse((self.target/'app/new.ts').exists())
        self.assertEqual((self.target/'app/view.ts').read_text(),'local edit')

    def test_removed_managed_file_and_unowned_integration(self):
        self.sync(); own=self.target/'custom_components/mech/panel.js'
        own.parent.mkdir(parents=True); own.write_text('integration')
        self.git('rm','app/view.ts'); self.commit()
        with self.assertRaisesRegex(ValueError,'out of date'): self.sync(check=True)
        self.assertTrue((self.target/'app/view.ts').exists())
        self.sync(); self.assertFalse((self.target/'app/view.ts').exists())
        self.assertEqual(own.read_text(),'integration')

    def test_existing_snapshot_must_match_and_symlinks_are_rejected(self):
        (self.target/'app').mkdir(); (self.target/'app/view.ts').write_text('different')
        with self.assertRaisesRegex(ValueError,'conflict'): self.sync()
        (self.target/'app/view.ts').unlink()
        (self.target/'app/view.ts').symlink_to(self.source/'app/view.ts')
        with self.assertRaisesRegex(ValueError,'[Ss]ymlink'): self.sync()

    def test_source_symlink_and_tampered_manifest_rejected(self):
        (self.source/'app/link').symlink_to('../android/private.txt'); self.commit()
        with self.assertRaisesRegex(ValueError,'[Ss]ymlink'): self.sync()
        self.git('rm','app/link'); self.commit(); self.sync()
        manifest=json.loads((self.target/'shared-source.json').read_text())
        manifest['files']['../escape']='0'*64
        (self.target/'shared-source.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'managed path'): self.sync()

    def test_root_symlink_cannot_delete_previous_snapshot(self):
        self.sync(); before=(self.target/'shared-source.json').read_bytes()
        self.git('rm', '-r', 'app')
        (self.source/'app').symlink_to('android', target_is_directory=True); self.commit()
        with self.assertRaisesRegex(ValueError, '[Ss]ymlink'): self.sync()
        self.assertEqual((self.target/'app/view.ts').read_text(), 'first')
        self.assertEqual((self.target/'shared-source.json').read_bytes(), before)

    def test_git_archive_attributes_cannot_hide_committed_source(self):
        self.write('.gitattributes', 'app/view.ts export-ignore\n'); self.commit()
        self.sync()
        self.assertEqual((self.target/'app/view.ts').read_text(), 'first')

    def test_unowned_file_in_mirror_is_not_silently_deleted(self):
        self.sync(); (self.target/'app/local.ts').write_text('preserve')
        with self.assertRaisesRegex(ValueError,'conflict'): self.sync()
        self.assertEqual((self.target/'app/local.ts').read_text(),'preserve')

if __name__ == '__main__': unittest.main()
