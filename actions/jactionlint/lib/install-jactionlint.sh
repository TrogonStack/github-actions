#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=SCRIPTDIR/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

: "${VERSION:?VERSION is required}"
asset=$(platform_asset jactionlint)

# Checksums jdx/jactionlint published for the version this action defaults
# to, so the default path trusts nothing fetched alongside the archive.
checksums="
2.1.0 linux_amd64 baebfc5792135438fb3bb5ea266c3bf2538a089753616f1988ef618e4c0c3cb1
2.1.0 linux_arm64 ec0c6496d8a2f37b2ae2a1af0fbf98d58df1f7c98a27cf9fdd64c20ad317234b
2.1.0 darwin_amd64 a88f2be76def62dd4fd9aed38c81d0db4144763012128a89800be80b1ee82e89
2.1.0 darwin_arm64 3766a4b0890d3eb36fe58760289885712131c7974de4bc9fabb9a3faa599e931
"

archive="jactionlint_${VERSION}_${asset}.tar.gz"
release="https://github.com/jdx/jactionlint/releases/download/v${VERSION}"
dest="${RUNNER_TEMP}/jactionlint/${VERSION}"
archive_path="${RUNNER_TEMP}/${archive}"
mkdir -p "$dest"

curl --fail --silent --show-error --location --output "$archive_path" "${release}/${archive}"

want=$(awk -v v="$VERSION" -v a="$asset" '$1==v && $2==a{print $3}' <<<"$checksums")
if [ -z "$want" ]; then
  # A version this action was not pinned against: fall back to the checksums
  # file that release publishes, rather than installing an unverified binary.
  sums="jactionlint_${VERSION}_checksums.txt"
  curl --fail --silent --show-error --location --output "${RUNNER_TEMP}/${sums}" "${release}/${sums}"
  want=$(awk -v f="$archive" '$2==f{print $1}' "${RUNNER_TEMP}/${sums}")
  if [ -z "$want" ]; then
    echo "::error::No checksum for ${archive} in ${release}/${sums}" >&2
    exit 1
  fi
fi

verify_sha256 "$archive_path" "$want" "$archive"

tar -xzf "$archive_path" -C "$dest" jactionlint
echo "$dest" >>"$GITHUB_PATH"
