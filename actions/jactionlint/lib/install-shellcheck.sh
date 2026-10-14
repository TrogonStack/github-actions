#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=SCRIPTDIR/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

asset=$(platform_asset shellcheck)

# Pinned rather than an input: accepting any version would mean installing a
# binary with no checksum to hold it to. Moving the pin is a release of this
# action.
version="0.11.0"
checksums="
linux.x86_64 b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6
linux.aarch64 68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc
darwin.x86_64 c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51
darwin.aarch64 339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f
"

archive="shellcheck-v${version}.${asset}.tar.gz"
dest="${RUNNER_TEMP}/shellcheck/${version}"
archive_path="${RUNNER_TEMP}/${archive}"
mkdir -p "$dest"

curl --fail --silent --show-error --location --output "$archive_path" \
  "https://github.com/koalaman/shellcheck/releases/download/v${version}/${archive}"

want=$(awk -v a="$asset" '$1==a{print $2}' <<<"$checksums")
verify_sha256 "$archive_path" "$want" "$archive"

tar -xzf "$archive_path" -C "$dest" --strip-components=1 "shellcheck-v${version}/shellcheck"
chmod +x "${dest}/shellcheck"
echo "$dest" >>"$GITHUB_PATH"
