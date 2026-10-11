#!/usr/bin/env bash
# Build the patched speedscope used by the oprof profile viewer webview.
#
#   scripts/build-speedscope.sh
#
# Clones upstream speedscope (MIT, https://github.com/jlfwong/speedscope) at
# $SPEEDSCOPE_TAG (default v1.25.0, falling back to the latest v1.x tag),
# applies scripts/speedscope.patch, runs speedscope's own release build
# (`--protocol file`: one IIFE script, no module chunks) and copies the static
# app into media/speedscope/ (git-ignored), with upstream's LICENSE.
#
# Env: SPEEDSCOPE_TAG     tag to build (default v1.25.0)
#      SPEEDSCOPE_REPO    git URL (default upstream GitHub)
#      SPEEDSCOPE_KEEP=1  keep the temporary clone (path is printed)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext="$(cd "$here/.." && pwd)"
patch="$here/speedscope.patch"
out="$ext/media/speedscope"
repo="${SPEEDSCOPE_REPO:-https://github.com/jlfwong/speedscope.git}"
tag="${SPEEDSCOPE_TAG:-v1.25.0}"

for tool in git node npm; do
  command -v "$tool" >/dev/null || { echo "build-speedscope: '$tool' not found in PATH" >&2; exit 1; }
done

if ! git ls-remote --exit-code --tags "$repo" "refs/tags/$tag" >/dev/null 2>&1; then
  latest="$(git ls-remote --tags --refs "$repo" 'v1.*' | sed 's#.*refs/tags/##' | sort -V | tail -n 1)"
  [ -n "$latest" ] || { echo "build-speedscope: no v1.x tag found in $repo" >&2; exit 1; }
  echo "build-speedscope: tag $tag not found, using $latest" >&2
  tag="$latest"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/speedscope-build.XXXXXX")"
cleanup() {
  if [ "${SPEEDSCOPE_KEEP:-}" = 1 ]; then echo "build-speedscope: kept $work" >&2; else rm -rf "$work"; fi
}
trap cleanup EXIT

src="$work/speedscope"
echo "build-speedscope: cloning $repo @ $tag" >&2
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$repo" "$src"

echo "build-speedscope: applying $(basename "$patch")" >&2
git -C "$src" apply --check "$patch"
git -C "$src" apply "$patch"

echo "build-speedscope: installing dependencies" >&2
(cd "$src" && npm ci --no-audit --no-fund --loglevel=error)

echo "build-speedscope: building" >&2
release="$src/dist/release"
(cd "$src" && ./scripts/prepack.sh --outdir "$release" --protocol file)

[ -f "$release/index.html" ] || { echo "build-speedscope: build produced no index.html" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
# Everything except source maps (the webview never needs them).
(cd "$release" && find . -type f ! -name '*.map' -print0 | xargs -0 cp --parents -t "$out")
# The favicon-*.js stubs are esbuild entry-point by-products; not referenced.
rm -f "$out"/favicon-*.js
cp "$src/LICENSE" "$out/LICENSE"
echo "$tag + oprof patch $(sha256sum "$patch" | cut -c1-12)" >> "$out/release.txt"

echo "build-speedscope: built speedscope $tag into $out" >&2
ls -1 "$out" >&2
