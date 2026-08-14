import os
from pathlib import Path

# load .env if present - keeps the api key out of shell profiles, no dotenv dep
_env = Path(__file__).parent.parent / ".env"
if _env.exists():
    for line in _env.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))

MODEL = os.getenv("MODEL", "claude-opus-5")
EFFORT = os.getenv("EFFORT", "")  # empty = api default (high)
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "64000"))  # hard spend ceiling per turn - thinking counts too
FIXTURE = os.getenv("FIXTURE", "")  # path to a recorded runs/*/stream.jsonl - replays it instead of calling the api. dir = cycle files per request
THEME = os.getenv("THEME", "")  # pin a daisyui theme across turns (continuity dial)
PIPELINE = os.getenv("PIPELINE", "single")  # single | staged (brief call -> render call)
BRIEF_MODEL = os.getenv("BRIEF_MODEL", "")  # staged only - defaults to MODEL
REVIEW = os.getenv("REVIEW", "blocking")  # blocking (draft streams, then vision review + revision before turn completes) | off
REVIEW_MODEL = os.getenv("REVIEW_MODEL", "claude-sonnet-5")  # needs vision
