#!/bin/bash
# Build the .vsix: bundle the extension, make sure speedscope is built, copy the Odoo addon in.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f media/speedscope/index.html ] || scripts/build-speedscope.sh
# the copies below are taken out again however the build ends, and a failed build leaves the
# version as it was
backup=$(mktemp -d)
cp package.json package-lock.json "$backup/"
trap 'rm -rf odoo_addon README.md; [ "${built:-}" = 1 ] || cp "$backup"/package*.json .; rm -rf "$backup"' EXIT
rm -rf odoo_addon && mkdir -p odoo_addon && cp -r ../odoo_addon/oprof odoo_addon/
# the README (shown on the extension's page in VS Code), from the repository's: its links to other
# files of the repository as text (a .vsix has no repository to link to)
sed -E -e 's/\[([^]]*)\]\(\1\)/\1 (in the repository)/g' -e 's/\[([^]]*)\]\(([^)#:]+)\)/\1 (\2, in the repository)/g' ../README.md > README.md
find odoo_addon -name __pycache__ -prune -exec rm -rf {} +
# a new version each time, so VS Code asks for a reload instead of keeping the old code running
npm version patch --no-git-tag-version >/dev/null
node scripts/build.mjs
npx vsce package --no-dependencies --allow-missing-repository --skip-license -o oprof.vsix
built=1
echo "Install with: code --install-extension $(pwd)/oprof.vsix"
