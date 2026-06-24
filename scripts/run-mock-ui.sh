#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bun run ui:mock -- [options] [agent-memory ui options]

Creates a temporary copy of examples/mock-app and runs the built UI against it.

Options handled by this script:
  --clean       Do not seed a proposed/low-confidence review item.
  --no-build    Skip bun run build and use existing dist/web UI assets.
  --help        Show this help.

Any other options are passed to agent-memory ui. If no --port is provided,
the script adds --port 0 so the UI picks an available local port.

Examples:
  bun run ui:mock
  bun run ui:mock -- --clean
  bun run ui:mock -- --no-build --port 4317
USAGE
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
build=1
seed_review=1
ui_args=()

while (($#)); do
  case "$1" in
    --clean)
      seed_review=0
      ;;
    --no-build)
      build=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      ui_args+=("$@")
      break
      ;;
    *)
      ui_args+=("$1")
      ;;
  esac
  shift
done

if ((build)); then
  (cd "$repo_root" && bun run build)
fi

if [[ ! -f "$repo_root/dist/web/index.html" ]]; then
  echo "Missing built UI assets at $repo_root/dist/web. Run bun run build or omit --no-build." >&2
  exit 1
fi

cli="$repo_root/packages/cli/src/index.ts"

tmpdir="$(mktemp -d -t agent-memory-mock-ui-XXXXXX)"
cp -R "$repo_root/examples/mock-app/." "$tmpdir"

if ((seed_review)); then
  claim="$tmpdir/docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md"
  sed -i '0,/^status: current$/s//status: proposed/' "$claim"
  sed -i '0,/^confidence: high$/s//confidence: low/' "$claim"
fi

has_port=0
for arg in "${ui_args[@]}"; do
  if [[ "$arg" == "--port" || "$arg" == --port=* ]]; then
    has_port=1
    break
  fi
done

if ((!has_port)); then
  ui_args=(--port 0 "${ui_args[@]}")
fi

echo "Mock app copied to: $tmpdir"
if ((seed_review)); then
  echo "Seeded review queue item: auth.student_oauth.uid_is_tenant_scoped"
fi
echo "Starting Agent Memory UI..."

cd "$tmpdir"
exec bun "$cli" ui "${ui_args[@]}"
