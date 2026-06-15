#!/usr/bin/env bash
#
# One-command release.
#
# Builds, signs, and notarizes BOTH macOS architectures (arm64 + x64), publishes
# them to a live GitHub Release, then triggers the Windows CI build which uploads
# the Windows installer + Squirrel auto-update feed to the same release.
#
# Usage:
#   1. Bump "version" in package.json (e.g. 0.9.2)
#   2. git commit -am "Release vX.Y.Z"
#   3. npm run release
#
# Requirements (already set up on this machine):
#   - Developer ID signing identity + AC_PASSWORD notarization profile (used by Forge)
#   - gh CLI logged in (provides the GitHub token for publishing)
#
set -euo pipefail

REPO="somersaudio/Unofficial-L-Acoustics-Calculator-Beta-0.9.1"
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

echo "==> Releasing ${TAG}"

# The Windows CI builds from the committed repo state, so local + remote must agree
# on the version. Refuse to release a dirty tree, then push.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: uncommitted changes. Commit the version bump first, then re-run." >&2
  exit 1
fi
git push origin HEAD

# gh provides the token used by @electron-forge/publisher-github
GITHUB_TOKEN="$(gh auth token)"
export GITHUB_TOKEN

# 1/5 — macOS Apple Silicon: build + sign + notarize + upload (creates the draft release)
echo "==> [1/5] macOS arm64 (build, sign, notarize, upload)…"
npm run publish -- --arch=arm64

# 2/5 — macOS Intel: build + sign + notarize locally
echo "==> [2/5] macOS x64 (build, sign, notarize)…"
npm run make -- --arch=x64

# 3/5 — upload the Intel zip to the same release.
# Match the CURRENT version explicitly — a stale zip from a previous release left in
# out/ would otherwise sort ahead of it and get uploaded by mistake.
echo "==> [3/5] Uploading macOS x64 to ${TAG}…"
X64_ZIP="$(ls out/make/zip/darwin/x64/*x64-${VERSION}.zip | head -1)"
if [ -z "${X64_ZIP}" ] || [ ! -f "${X64_ZIP}" ]; then
  echo "ERROR: no x64 zip for ${VERSION} in out/make/zip/darwin/x64/" >&2
  exit 1
fi
gh release upload "${TAG}" "${X64_ZIP}" -R "${REPO}" --clobber

# 4/5 — make the release live (so update.electronjs.org serves it)
echo "==> [4/5] Publishing release ${TAG}…"
gh release edit "${TAG}" -R "${REPO}" --draft=false

# 5/5 — trigger the Windows build in CI (uploads Setup.exe + RELEASES + .nupkg to ${TAG})
echo "==> [5/5] Triggering Windows CI…"
gh workflow run release.yml -R "${REPO}"

echo ""
echo "✅ ${TAG}: macOS arm64 + x64 published. Windows is building in CI."
echo "   Release: https://github.com/${REPO}/releases/tag/${TAG}"
echo "   Latest:  https://github.com/${REPO}/releases/latest"
echo "   Windows CI: https://github.com/${REPO}/actions"
