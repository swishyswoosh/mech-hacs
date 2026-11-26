"""Repository and archive contracts; no Bluetooth or network access."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("hacs_package", ROOT / "scripts/hacs_package.py")


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(SPEC.origin).is_file(), "HACS repository packager is missing")
        self.package = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.package)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def component(self):
        component = self.root / "custom_components/mech"
        component.mkdir(parents=True)
        for name in ("manifest.json", "__init__.py", "frontend/panel.js", "frontend/controller/index.html", "brand/icon.png"):
            path = component / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}" if name.endswith("json") else "fixture")
        return component

    def test_hacs_archive_extracts_directly_into_domain_directory(self):
        component = self.component()
        output = self.root / "mech.zip"
        self.package.write_archive(component, output, "hacs")
        installed = self.root / "ha/custom_components/mech"
        with zipfile.ZipFile(output) as archive:
            archive.extractall(installed)
            self.assertNotIn("custom_components/mech/manifest.json", archive.namelist())
        self.assertTrue((installed / "manifest.json").is_file())
        self.assertTrue((installed / "frontend/controller/index.html").is_file())

    def test_manual_archive_retains_configuration_directory_layout(self):
        component = self.component()
        output = self.root / "manual.zip"
        self.package.write_archive(component, output, "manual")
        with zipfile.ZipFile(output) as archive:
            self.assertIn("custom_components/mech/manifest.json", archive.namelist())

    def test_archive_rejects_missing_frontend_and_symlinks(self):
        component = self.component()
        (component / "frontend/controller/index.html").unlink()
        with self.assertRaisesRegex(ValueError, "frontend"):
            self.package.write_archive(component, self.root / "missing.zip", "hacs")
        (component / "frontend/controller/index.html").write_text("fixture")
        (component / "linked.py").symlink_to(component / "__init__.py")
        with self.assertRaisesRegex(ValueError, "[Ss]ymlink"):
            self.package.write_archive(component, self.root / "linked.zip", "hacs")

    def test_archive_omits_caches_and_is_reproducible(self):
        component = self.component()
        (component / "__pycache__").mkdir()
        (component / "__pycache__/private.pyc").write_bytes(b"cache")
        first, second = self.root / "one.zip", self.root / "two.zip"
        self.package.write_archive(component, first, "hacs")
        self.package.write_archive(component, second, "hacs")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            self.assertFalse(any("__pycache__" in name for name in archive.namelist()))

    def test_release_validation_requires_identity_and_license(self):
        component = self.component()
        (self.root / "hacs.json").write_text(json.dumps({"name": "Mech", "zip_release": True, "filename": "mech.zip", "hide_default_branch": True, "homeassistant": "2026.11.0"}))
        (self.root / "README.md").write_text("Mech")
        errors = self.package.repository_errors(self.root)
        self.assertTrue(any("documentation" in error for error in errors))
        self.assertTrue(any("codeowners" in error for error in errors))
        self.assertTrue(any("LICENSE" in error for error in errors))

    def test_icon_notice_survives_the_hacs_release_archive(self):
        (self.root / "licenses").mkdir()
        (self.root / "licenses/material-symbols-LICENSE.txt").write_text("Apache License 2.0")
        (self.root / "THIRD_PARTY_NOTICES.md").write_text("Material Symbols: Google")
        (self.root / "web").mkdir()
        package = "node_modules/fbjs/node_modules/promise"
        (self.root / "web/package-lock.json").write_text(json.dumps({"packages": {package: {}}}))
        dependency = self.root / "web" / package
        dependency.mkdir(parents=True)
        (dependency / "LICENSE").write_text("Nested dependency attribution")
        icons = self.root / "app/assets/material-symbols"
        icons.mkdir(parents=True)
        notice = "Google Material Symbols Outlined\nCopyright Google LLC\nOriginal provenance preserved.\n"
        (icons / "NOTICE").write_text(notice)
        component = self.component()
        self.package.collect_notices(self.root, component / "frontend/licenses")
        self.package.write_archive(component, self.root / "release.zip", "hacs")
        with zipfile.ZipFile(self.root / "release.zip") as archive:
            self.assertIn("frontend/licenses/project-assets/material-symbols-NOTICE.txt", archive.namelist())
            self.assertEqual(archive.read("frontend/licenses/project-assets/material-symbols-NOTICE.txt").decode(), notice)
            self.assertEqual(archive.read("frontend/licenses/project-assets/material-symbols-LICENSE.txt").decode(), "Apache License 2.0")
            self.assertIn("frontend/licenses/npm/fbjs/promise/LICENSE", archive.namelist())
            self.assertEqual(archive.read("frontend/licenses/npm/fbjs/promise/LICENSE").decode(), "Nested dependency attribution")

    def test_release_tag_must_match_complete_manifest(self):
        component = self.component()
        (component / "manifest.json").write_text(json.dumps({"domain": "mech", "name": "Mech", "version": "1.2.3", "documentation": "https://github.com/fixture/mech", "issue_tracker": "https://github.com/fixture/mech/issues", "codeowners": ["@fixture"]}))
        (self.root / "hacs.json").write_text(json.dumps({"name": "Mech", "zip_release": True, "filename": "mech.zip", "hide_default_branch": True, "homeassistant": "2026.11.0"}))
        (self.root / "README.md").write_text("fixture")
        (self.root / "LICENSE").write_text("fixture license")
        self.assertEqual(self.package.repository_errors(self.root, tag="v1.2.3"), [])
        self.assertIn("Release tag must match manifest version", self.package.repository_errors(self.root, tag="v1.2.4"))


if __name__ == "__main__":
    unittest.main()
