#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=SCRIPTDIR/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

: "${VERSION:?VERSION is required}"
asset=$(platform_asset actionlint)

# Checksums rhysd/actionlint published for the version this action defaults
# to, so the default path trusts nothing fetched alongside the archive.
checksums="
1.7.12 linux_amd64 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
1.7.12 linux_arm64 325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
1.7.12 darwin_amd64 5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644
1.7.12 darwin_arm64 aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
"

archive="actionlint_${VERSION}_${asset}.tar.gz"
release="https://github.com/rhysd/actionlint/releases/download/v${VERSION}"
dest="${RUNNER_TEMP}/actionlint/${VERSION}"
archive_path="${RUNNER_TEMP}/${archive}"
mkdir -p "$dest"

curl --fail --silent --show-error --location --output "$archive_path" "${release}/${archive}"

want=$(awk -v v="$VERSION" -v a="$asset" '$1==v && $2==a{print $3}' <<<"$checksums")
if [ -z "$want" ]; then
  # A version this action was not pinned against: fall back to the checksums
  # file that release publishes, rather than installing an unverified binary.
  sums="actionlint_${VERSION}_checksums.txt"
  curl --fail --silent --show-error --location --output "${RUNNER_TEMP}/${sums}" "${release}/${sums}"
  want=$(awk -v f="$archive" '$2==f{print $1}' "${RUNNER_TEMP}/${sums}")
  if [ -z "$want" ]; then
    echo "::error::No checksum for ${archive} in ${release}/${sums}" >&2
    exit 1
  fi
fi

verify_sha256 "$archive_path" "$want" "$archive"

tar -xzf "$archive_path" -C "$dest" actionlint
echo "$dest" >>"$GITHUB_PATH"
