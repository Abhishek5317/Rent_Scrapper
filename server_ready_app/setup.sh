#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-managed}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip

if [[ "$MODE" == "direct" ]]; then
  pip install -r requirements-browser.txt
  echo "Direct mode installed. Set CHROME_PATH in .env if system Chrome is not auto-detected."
else
  pip install -r requirements.txt
fi

mkdir -p data debug
[[ -f .env ]] || cp .env.example .env
chmod +x start.sh

echo
printf 'Setup complete. Edit .env, then run: ./start.sh\n'
