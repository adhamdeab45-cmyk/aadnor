#!/usr/bin/env bash
set -euo pipefail
rm -rf dist
mkdir -p dist
cp index.html admin.html agent.html bootstrap.html offline.html manifest.webmanifest sw.js deploy-check.txt VERSION.txt dist/
cp -R assets legal dist/
echo "ADNOR V301 static files prepared in dist/"
