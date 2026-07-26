#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt

mkdir -p data
[[ -f .env ]] || cp .env.example .env
chmod +x start.sh

echo
printf 'Setup complete. Edit .env if needed, then run: ./start.sh\n'
