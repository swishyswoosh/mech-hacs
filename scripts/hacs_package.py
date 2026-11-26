"""Assemble deterministic HACS installation archives."""
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

EXCLUDED = {"node_modules", "dist", "build", "frontend", "__pycache__", ".venv", ".pytest_cache", ".DS_Store"}


def integration_path(root):
    return root / "custom_components/mech"


def source_files(directory, *, exclude=EXCLUDED):
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if any(part in exclude for part in relative.parts) or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.is_symlink():
            raise ValueError(f"Symlink cannot be packaged: {relative}")
        if path.is_file():
            yield path


def write_archive(component, output, layout):
    if layout not in {"hacs", "manual"}:
        raise ValueError("Unknown archive layout")
    for required in ("manifest.json", "__init__.py", "frontend/panel.js", "frontend/controller/index.html"):
        if not (component / required).is_file():
            raise ValueError(f"Missing packaged runtime: {required}")
    files = list(source_files(component, exclude=EXCLUDED - {"frontend"}))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        staged = Path(temporary) / "package.zip"
        with zipfile.ZipFile(staged, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in files:
                name = path.relative_to(component).as_posix()
                if layout == "manual":
                    name = f"custom_components/mech/{name}"
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
        staged.replace(output)


def repository_errors(root, *, tag=None):
    errors = []
    component = root / "custom_components/mech"
    for required in ("hacs.json", "README.md", "LICENSE", "custom_components/mech/manifest.json", "custom_components/mech/brand/icon.png"):
        if not (root / required).is_file():
            errors.append(f"Missing {required}")
    components = root / "custom_components"
    if components.is_dir() and sorted(p.name for p in components.iterdir() if p.is_dir() and p.name != "__pycache__") != ["mech"]:
        errors.append("Repository must contain exactly one integration: mech")
    try:
        manifest = json.loads((component / "manifest.json").read_text())
        for field in ("domain", "name", "version", "documentation", "issue_tracker", "codeowners"):
            if not manifest.get(field):
                errors.append(f"Manifest requires {field}")
        if manifest.get("domain") != "mech":
            errors.append("Manifest domain must be mech")
        for field in ("documentation", "issue_tracker"):
            if manifest.get(field) and not re.fullmatch(r"https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+(?:/issues)?", manifest[field]):
                errors.append(f"Invalid {field} URL")
        if not isinstance(manifest.get("codeowners"), list) or any(not re.fullmatch(r"@[A-Za-z0-9-]+", owner) for owner in manifest.get("codeowners", [])):
            errors.append("codeowners must contain GitHub user handles")
        if tag is not None and tag.removeprefix("v") != manifest.get("version"):
            errors.append("Release tag must match manifest version")
        hacs = json.loads((root / "hacs.json").read_text())
        for key, value in {"zip_release": True, "filename": "mech.zip", "hide_default_branch": True}.items():
            if hacs.get(key) != value:
                errors.append(f"hacs.json requires {key}={value}")
        if not hacs.get("name") or not hacs.get("homeassistant"):
            errors.append("hacs.json requires name and homeassistant")
    except (OSError, ValueError) as error:
        errors.append(str(error))
    return errors


def copy_source(source, destination):
    for file in source_files(source):
        target = destination / file.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)


def collect_notices(root, destination):
    """Bundle dependency licenses alongside compiled assets."""
    copy_source(root / "licenses", destination / "project-assets")
    shutil.copy2(root / "app/assets/material-symbols/NOTICE", destination / "project-assets/material-symbols-NOTICE.txt")
    shutil.copy2(root / "THIRD_PARTY_NOTICES.md", destination / "THIRD_PARTY_NOTICES.md")
    for path in (root / "app/theme/fonts").glob("*OFL.txt"):
        shutil.copy2(path, destination / path.name)
    lock = json.loads((root / "web/package-lock.json").read_text())
    for package in lock["packages"]:
        if not package.startswith("node_modules/"):
            continue
        directory = root / "web" / package
        if not directory.is_dir():
            continue  # Platform-specific optional dependencies may be absent.
        for path in directory.iterdir():
            if path.is_file() and re.match(r"^(license|licence|copying|notice)(\.|$)", path.name, re.I):
                # Dependency ancestry remains visible without node_modules paths,
                # which the archive's source/cache exclusions would discard.
                package_name = package.removeprefix("node_modules/").replace("/node_modules/", "/")
                target = destination / "npm" / package_name / path.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
    if (root / "LICENSE").is_file():
        shutil.copy2(root / "LICENSE", destination / "LICENSE")
