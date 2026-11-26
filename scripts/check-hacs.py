"""Check the exported repository's release prerequisites before publication."""
import argparse
from pathlib import Path
from hacs_package import repository_errors

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument("--tag")
args = parser.parse_args()
errors = repository_errors(args.root, tag=args.tag)
if errors:
    raise SystemExit("\n".join(errors))
print("HACS repository structure and release metadata passed")
