# shellcheck shell=bash

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

verify_sha256() {
  local path="$1" want="$2" name="$3" got
  got=$(sha256_of "$path")
  if [ "$got" != "$want" ]; then
    echo "::error::${name} checksum mismatch: expected ${want}, got ${got}" >&2
    exit 1
  fi
}

# Prints the release asset suffix the named tool publishes for this runner.
platform_asset() {
  local tool="$1"
  case "${RUNNER_OS}-${RUNNER_ARCH}" in
    Linux-X64) [ "$tool" = actionlint ] && echo linux_amd64 || echo linux.x86_64 ;;
    Linux-ARM64) [ "$tool" = actionlint ] && echo linux_arm64 || echo linux.aarch64 ;;
    macOS-ARM64) [ "$tool" = actionlint ] && echo darwin_arm64 || echo darwin.aarch64 ;;
    macOS-X64) [ "$tool" = actionlint ] && echo darwin_amd64 || echo darwin.x86_64 ;;
    *)
      echo "::error::Unsupported runner ${RUNNER_OS}/${RUNNER_ARCH}. This action supports Linux X64/ARM64 and macOS X64/ARM64." >&2
      return 1
      ;;
  esac
}
