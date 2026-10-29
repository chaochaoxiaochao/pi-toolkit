#!/usr/bin/env python3
"""Real demo jobs. Explicit release files control completion for screen recording."""
from pathlib import Path
import sys
import time

kind = sys.argv[1]
if kind not in ("build", "tests"):
    raise SystemExit("expected build or tests")

print(f"Starting {kind} demo job (real local process)", flush=True)
count = 0
while not Path(f"release-{kind}").exists():
    count += 1
    if kind == "build":
        print(f"\rCompiling module {count:03d} ...", end="", flush=True)
    else:
        print(f"test_{count:03d} ... passed", flush=True)
    time.sleep(0.5)  # Output cadence only; completion is controlled by the release file.

print("\nBUILD SUCCESSFUL" if kind == "build" else "TEST SUITE COMPLETE: one demo failure", flush=True)
raise SystemExit(0 if kind == "build" else 3)
