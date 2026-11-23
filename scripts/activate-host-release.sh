#!/usr/bin/env bash
# Runs on the Host as root, with /opt/amc/.deploy.lock held by deploy-host.sh.
set -euo pipefail
sha=$1
upload=$2
version=$3
root=/opt/amc
release="$root/releases/$sha"
pending="$root/.activation-pending"
current=$(readlink -f "$root/current" 2>/dev/null || true)
if [[ -L "$root/current" ]]; then
  if [[ "$current" != "$root/releases/"* || ! -d "$current" ]]; then
    echo "Current release symlink is invalid." >&2
    exit 1
  fi
elif [[ -e "$root/current" ]]; then
  echo "Current release path is not a symlink." >&2
  exit 1
else
  current=
fi
previous="$current"
if [[ -f "$pending" ]]; then
  {
    read -r pending_release
    read -r previous
  } < "$pending"
  if [[ "$pending_release" != "$release" || ( "$current" != "$release" && "$current" != "$previous" ) ||
      ( -n "$previous" && ( "$previous" != "$root/releases/"* || ! -d "$previous" ) ) ]]; then
    echo "Resolve the interrupted Host activation before changing its target." >&2
    exit 70
  fi
fi

health() {
  curl -fsS --max-time 2 http://127.0.0.1:4410/health >/dev/null 2>&1
}

invocation() {
  systemctl show --property=InvocationID --value amc-engine.service
}

wait_for_health() {
  for _ in $(seq 1 20); do
    if systemctl is-active --quiet amc-engine.service && health; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Recheck version under the same lock as activation. Leave a newer Host intact.
if [[ -n "$version" && -n "$current" && -s "$current/VERSION" ]]; then
  installed_version=$(cat "$current/VERSION")
  if [[ $(printf '%s\n' "$installed_version" "$version" | sort -V | tail -n 1) != "$version" ]] ||
    [[ "$installed_version" == "$version" && "$current" != "$release" ]]; then
    echo "Host has the same version from a different commit or a newer release." >&2
    exit 1
  fi
fi

work=$(mktemp -d "$root/.activate.XXXXXXXX")
switch_in_progress=false
set_current() {
  rm -f -- "$work/current"
  ln -s -- "$1" "$work/current" || return 1
  mv -Tf -- "$work/current" "$root/current"
}
finish() {
  local status=$?
  if "$switch_in_progress"; then
    echo "Engine activation failed. Restoring the prior service; schema migrations remain applied." >&2
    if [[ -n "$previous" ]]; then
      if set_current "$previous" && systemctl restart amc-engine.service && wait_for_health; then
        echo "Previous Engine is healthy." >&2
        rm -f -- "$pending"
      else
        echo "Previous Engine failed to recover. Check the Host journal and AMC rollback runbook." >&2
        status=70
      fi
    else
      systemctl stop amc-engine.service || true
      rm -f -- "$root/current"
      rm -f -- "$pending"
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap finish EXIT

if [[ ! -e "$release" ]]; then
  mkdir "$work/release"
  install -m 644 "$upload/amc-engine.mjs" "$upload/amc-engine.mjs.map" "$upload/amc.mjs" "$work/release/"
  printf '%s\n' "$sha" > "$work/release/RELEASE"
  mv -T -- "$work/release" "$release"
fi
if [[ -L "$release" || ! -f "$release/RELEASE" || $(cat "$release/RELEASE") != "$sha" ||
      ! -s "$release/amc-engine.mjs" || ! -s "$release/amc-engine.mjs.map" || ! -s "$release/amc.mjs" ]]; then
  echo "Existing release directory is incomplete. Inspect it on the Host before retrying." >&2
  exit 1
fi

running=$(invocation)
if [[ "$current" != "$release" || ! -s "$release/INVOCATION" ||
      -z "$running" || $(cat "$release/INVOCATION") != "$running" ]] ||
    ! systemctl is-active --quiet amc-engine.service || ! health; then
  printf '%s\n' "$release" "$previous" > "$work/pending"
  mv -Tf -- "$work/pending" "$pending"
  switch_in_progress=true
  systemctl stop amc-engine.service
  set_current "$release"
  systemd-cat --identifier=amc-migration /usr/local/bin/amc-engine migrate --journal
  systemctl start amc-engine.service
  running=$(invocation)
  wait_for_health
  [[ -n "$running" && $(invocation) == "$running" ]]
  printf '%s\n' "$running" > "$work/INVOCATION"
  mv -T -- "$work/INVOCATION" "$release/INVOCATION"
  switch_in_progress=false
fi
rm -f -- "$pending"

if [[ -n "$version" ]]; then
  printf '%s\n' "$version" > "$work/VERSION"
  mv -T -- "$work/VERSION" "$release/VERSION"
fi
install -m 644 "$upload/amc-backup.service" "$upload/amc-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now amc-backup.timer
systemctl restart amc-backup.timer
systemctl is-active --quiet amc-backup.timer

# Keep the current and previous releases plus the five newest directories.
[[ $(readlink -f "$root/current") == "$release" ]]
while IFS= read -r old; do
  if [[ "$old" != "$release" && "$old" != "$previous" &&
        "${old##*/}" =~ ^([a-f0-9]{12,39}(-dirty(-[0-9]+-[0-9]+)?)?|[a-f0-9]{40})$ &&
        -d "$old" && ! -L "$old" ]]; then
    rm -rf -- "$old"
  fi
done < <(ls -1dt -- "$root"/releases/* | tail -n +6)
echo "✓ Engine and backup timer healthy."
