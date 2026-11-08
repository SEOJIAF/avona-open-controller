#!/bin/sh
# Creates a private certificate authority and a server certificate so the controller can be served over
# HTTPS on your LAN (Web Bluetooth on phones needs HTTPS). Install certs/ca.crt on the phone once.
#
#   tools/make-local-https.sh 192.168.1.20 [my-laptop.local ...]
#   TLS_CERT=certs/server.crt TLS_KEY=certs/server.key HOST=0.0.0.0 node server.mjs
set -eu
[ $# -ge 1 ] || { echo "usage: $0 <lan-ip-or-hostname> [more names...]" >&2; exit 1; }
cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

if [ ! -f ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout ca.key -out ca.crt -subj "/CN=open-avona local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi

san="DNS:localhost,IP:127.0.0.1"
for name in "$@"; do
  case "$name" in
    *[!0-9.]*) san="$san,DNS:$name" ;;
    *) san="$san,IP:$name" ;;
  esac
done

openssl req -newkey rsa:2048 -nodes -sha256 -keyout server.key -out server.csr -subj "/CN=$1" 2>/dev/null
printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > server.ext
# 397 days: browsers reject longer-lived server certificates.
openssl x509 -req -sha256 -days 397 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -extfile server.ext 2>/dev/null
rm -f server.csr server.ext
openssl x509 -in ca.crt -outform der -out ca.der
chmod 600 ca.key server.key

echo "Created $(pwd)/server.crt for: $san"
echo "Install $(pwd)/ca.crt (or ca.der) on each phone as a CA certificate, then start the server with:"
echo "  TLS_CERT=certs/server.crt TLS_KEY=certs/server.key HOST=0.0.0.0 node server.mjs"
