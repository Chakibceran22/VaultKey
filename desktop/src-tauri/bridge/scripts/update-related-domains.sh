#!/usr/bin/env bash
# Refreshes the related-domains data (extension/plans/04, "Related domains"): Apple's
# password-manager-resources `quirks/shared-credentials.json` (MIT) and its license, pinned
# at one commit, into bridge/src/data/. The bridge builds them in (`related.rs`).
#
#   bridge/scripts/update-related-domains.sh          # the latest commit on main
#   bridge/scripts/update-related-domains.sh <sha>    # a given commit (full 40 characters)
#
# Then run `cargo test -p vaultkey-bridge -j 2`: it checks the file still has the shape
# `related.rs` reads, and that lookalikes still match nothing. Review the diff before
# committing: every new group lets one site's logins be offered on another.
set -euo pipefail

repo=apple/password-manager-resources
data="$(cd "$(dirname "$0")/.." && pwd)/src/data"

sha="${1:-}"
if [ -z "$sha" ]; then
  # The bare sha of main's head.
  sha="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$repo/commits/main")"
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "not a full commit sha: $sha" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
raw="https://raw.githubusercontent.com/$repo/$sha"
curl -fsSL "$raw/quirks/shared-credentials.json" -o "$tmp/shared-credentials.json"
curl -fsSL "$raw/LICENSE.md" -o "$tmp/LICENSE.md"

# A JSON array at least; the tests check the rest.
if [ "$(head -c 1 "$tmp/shared-credentials.json")" != "[" ]; then
  echo "shared-credentials.json isn't a JSON array any more: check upstream's format" >&2
  exit 1
fi

mv "$tmp/shared-credentials.json" "$data/shared-credentials.json"
mv "$tmp/LICENSE.md" "$data/LICENSE-password-manager-resources.md"
printf '%s\n' "$sha" > "$data/shared-credentials.commit"
echo "related domains now at $repo@$sha"
