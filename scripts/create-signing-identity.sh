#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Darwin ]]; then
  printf '%s\n' 'AMC local signing requires macOS.' >&2
  exit 1
fi

name='AMC Local Code Signing'
login_keychain="$HOME/Library/Keychains/login.keychain-db"
identities=$(/usr/bin/security find-identity -p codesigning "$login_keychain")
if [[ $identities == *"\"$name\""* ]]; then
  printf 'Signing identity already exists in the login keychain: %s\n' "$name"
  exit 0
fi

# Trust a system no-op for the private key's ACL so that codesign needs
# owner approval. Any process running as this user can invoke codesign.
set +x
umask 077
ulimit -c 0
temp_dir=$(mktemp -d)
archive="$temp_dir/$name.p12"
trap 'rm -f "$archive"; rmdir "$temp_dir"' EXIT
trap 'exit 1' HUP INT TERM
password=$(/usr/bin/openssl rand -hex 32)
/usr/bin/openssl req -new -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -subj "/CN=$name" -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=codeSigning' \
  -keyout /dev/stdout -out /dev/stdout |
  /usr/bin/openssl pkcs12 -export -descert -name "$name" \
    -out "$archive" -passout fd:3 3< <(printf '%s\n' "$password")

# security import requires a seekable file. Only the encrypted PKCS#12 reaches
# disk. Send its random password over stdin, outside the process argument list.
printf 'import "%s" -k "%s" -f pkcs12 -x -T /usr/bin/false -P %s\n' \
  "$archive" "$login_keychain" "$password" | /usr/bin/security -i -q
unset password
identities=$(/usr/bin/security find-identity -p codesigning "$login_keychain")
if [[ $identities != *"\"$name\""* ]]; then
  printf 'Could not import signing identity: %s\n' "$name" >&2
  exit 1
fi

printf 'Created signing identity in the login keychain: %s\n' "$name"
