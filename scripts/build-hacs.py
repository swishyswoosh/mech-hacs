"""Bundle the shared controller and package an installable HACS integration."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
from hacs_package import collect_notices, integration_path, write_archive

ROOT = Path(__file__).resolve().parents[1]


def build(output, layout="manual"):
    subprocess.run(["npm", "--prefix", str(ROOT / "web"), "run", "build", "--", "--base", "./"], check=True, cwd=ROOT)
    integration = integration_path(ROOT)
    frontend = integration / "frontend"
    # Stage complete output before replacing the generated deployment directory.
    with tempfile.TemporaryDirectory(prefix="mech-hacs-") as temporary:
        stage = Path(temporary) / "frontend"
        shutil.copytree(ROOT / "web/dist", stage / "controller")
        shutil.copy2(integration / "panel.js", stage / "panel.js")
        collect_notices(ROOT, stage / "licenses")
        if frontend.exists():
            shutil.rmtree(frontend)
        shutil.copytree(stage, frontend)
    write_archive(integration, output, layout)
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "build/mech-manual.zip")
    parser.add_argument("--layout", choices=("hacs", "manual"), default="manual")
    args = parser.parse_args()
    build(args.output.resolve(), args.layout)
