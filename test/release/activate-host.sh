#!/usr/bin/env bash
# Exercise Host activation with temporary files and fake systemd/HTTP commands.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
sandbox=$(mktemp -d)
sandbox=$(cd "$sandbox" && pwd -P)
trap 'rm -rf -- "$sandbox"' EXIT
old=aaaaaaaaaaaa
new=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
root="$sandbox/opt"
old_release="$root/releases/$old"
new_release="$root/releases/$new"
upload="$sandbox/upload"
mkdir -p "$old_release" "$upload" "$sandbox/bin" "$sandbox/system"
ln -s "$old_release" "$root/current"
printf '%s\n' old-invocation > "$sandbox/invocation"
printf '%s\n' 0.1.1 > "$old_release/VERSION"
for file in amc-engine.mjs amc-engine.mjs.map amc.mjs amc-backup.service amc-backup.timer; do
  printf '%s\n' "$file" > "$upload/$file"
done
sed -e "s#^root=/opt/amc\$#root=\"$root\"#" \
  -e "s#/etc/systemd/system/#\"$sandbox/system/\"#" \
  "$repo/scripts/activate-host-release.sh" > "$sandbox/activate.sh"
if grep -Eq '/opt/amc|/etc/systemd/system' < <(sed '/^#/d' "$sandbox/activate.sh"); then
  echo 'Activation fixture must use temporary paths' >&2
  exit 1
fi

cat > "$sandbox/bin/systemctl" <<'FAKE'
#!/usr/bin/env bash
set -eu
case "$1" in
  show) cat "$fixture/invocation" ;;
  start|restart)
    printf '%s\n' "$*" >> "$fixture/service-calls"
    if [[ "$*" == 'start amc-engine.service' && -f "$fixture/fail-start" ]]; then
      exit 1
    fi
    if [[ "$2" == amc-engine.service ]]; then
      printf '%s\n' "${1}-$$" > "$fixture/invocation"
    elif [[ -f "$fixture/fail-timer" ]]; then
      exit 1
    fi
    ;;
esac
FAKE
cat > "$sandbox/bin/systemd-cat" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' migrate >> "$fixture/service-calls"
FAKE
cat > "$sandbox/bin/curl" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
# macOS mv lacks GNU -T. Rename to the exact path, including symlinks to directories.
cat > "$sandbox/bin/mv" <<'FAKE'
#!/usr/bin/env bash
set -eu
[[ "$1" == -T || "$1" == -Tf ]]
[[ "$2" == -- ]]
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$3" "$4"
FAKE
chmod +x "$sandbox/bin/"*
export fixture="$sandbox"
export PATH="$sandbox/bin:$PATH"

activate() {
  bash "$sandbox/activate.sh" "$1" "$upload" "$2"
}

touch "$sandbox/fail-start"
if activate "$new" 0.1.2; then exit 1; fi
[[ $(readlink "$root/current") == "$old_release" ]]
[[ -f "$new_release/amc-engine.mjs" ]]
[[ ! -e "$new_release/INVOCATION" ]]

# Simulate interruption after the symlink switched, before a new invocation was recorded.
ln -s "$new_release" "$root/interrupted"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$root/interrupted" "$root/current"
printf '%s\n' "$new_release" "$old_release" > "$root/.activation-pending"
if activate "$new" 0.1.2; then exit 1; fi
[[ $(readlink "$root/current") == "$old_release" ]]
[[ ! -e "$root/.activation-pending" ]]
rm "$sandbox/fail-start"

touch "$sandbox/fail-timer"
if activate "$new" 0.1.2; then exit 1; fi
[[ $(readlink "$root/current") == "$new_release" ]]
[[ $(cat "$new_release/INVOCATION") == "$(cat "$sandbox/invocation")" ]]
[[ $(cat "$new_release/VERSION") == 0.1.2 ]]
rm "$sandbox/fail-timer"

: > "$sandbox/service-calls"
printf 'modified-upload\n' > "$upload/amc-engine.mjs"
activate "$new" 0.1.2
[[ $(cat "$new_release/amc-engine.mjs") == amc-engine.mjs ]]
[[ $(cat "$sandbox/service-calls") == 'restart amc-backup.timer' ]]
if activate "$old" 0.1.1; then exit 1; fi
[[ $(readlink "$root/current") == "$new_release" ]]
