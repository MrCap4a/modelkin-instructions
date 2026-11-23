#!/usr/bin/env bash
set -Eeuo pipefail

stage=$1
revision=$2
domain=$3
root=$HOME/modelkin-instruction

cd "$root"
exec 9>.deploy.lock
flock 9

if [[ ! -s .env ]]; then
    echo "Missing $root/.env. See deploy/README.md." >&2
    exit 1
fi
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ || ! "$domain" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]]; then
    echo "Invalid revision or domain." >&2
    exit 1
fi

gzip -dc "$stage/image.tar.gz" | docker load
config=$(mktemp -d "$root/.release-config.XXXXXX")
trap 'if [[ "$(readlink "$root/current" || true)" != "$config" ]]; then
    rm -f -- "$config/compose.yml" "$config/release.env"
    rmdir -- "$config"
fi' EXIT
cp "$stage/compose.yml" "$config/compose.yml"
printf 'APP_IMAGE=modelkin-instruction:%s\n' "$revision" >"$config/release.env"
previous=$(readlink "$root/current" || true)
ln -s "$config" "$stage/current-link"

# Resolve relative paths from the production directory even when using staged files.
base=(docker compose --project-directory "$root" --env-file "$root/.env")
candidate=("${base[@]}" --env-file "$config/release.env" -f "$config/compose.yml")

check_public() {
    local actual
    for _ in {1..12}; do
        if actual=$(curl -fsS --max-time 5 "https://$domain/healthz") && [[ "$actual" == "$revision" ]]; then
            return 0
        fi
        sleep 5
    done
    return 1
}

# Switch the compose file and image reference together after the health checks.
if "${candidate[@]}" up -d --wait --wait-timeout 120 --pull missing &&
        check_public && mv -Tf "$stage/current-link" "$root/current"; then
    if [[ "$previous" == "$root"/.release-config.* ]]; then
        rm -f -- "$previous/compose.yml" "$previous/release.env"
        rmdir -- "$previous" || true
    fi
    "${candidate[@]}" ps
else
    echo "Release did not pass health checks." >&2
    "${candidate[@]}" logs --tail=50 app >&2 || true
    if [[ -f "$root/current/release.env" ]]; then
        "${base[@]}" --env-file "$root/current/release.env" -f "$root/current/compose.yml" up -d --wait --wait-timeout 120 --pull missing
    else
        "${candidate[@]}" stop app || true
    fi
    exit 1
fi
