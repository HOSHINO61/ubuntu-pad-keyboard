#!/bin/sh
# Assemble the .deb for PAD-OSK.
#
# Run from the project root on a Debian/Ubuntu host (needs dpkg-deb).
# Produces dist/pad-osk_<ver>_<arch>.deb from the files already in this
# repo, so the package can never drift from the source tree.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG=pad-osk
STAGE="$ROOT/packaging/$PKG"
DIST="$ROOT/dist"

VER=$(sed -n 's/^Version: *//p' "$STAGE/DEBIAN/control" | head -1)
ARCH=$(sed -n 's/^Architecture: *//p' "$STAGE/DEBIAN/control" | head -1)
[ -n "$VER" ] || { echo "cannot read Version from control" >&2; exit 1; }
[ -n "$ARCH" ] || { echo "cannot read Architecture from control" >&2; exit 1; }
DEB="$DIST/${PKG}_${VER}_${ARCH}.deb"

echo "=== staging $PKG $VER ==="
rm -rf "$STAGE/usr" "$DIST"
mkdir -p \
    "$STAGE/usr/share/gnome-shell/extensions/erhai-osk@local" \
    "$STAGE/usr/bin" \
    "$STAGE/usr/share/applications" \
    "$DIST"

cp "$ROOT/scripts/erhai-osk-ext/extension.js" \
   "$ROOT/scripts/erhai-osk-ext/metadata.json" \
   "$STAGE/usr/share/gnome-shell/extensions/erhai-osk@local/"

cp "$ROOT/scripts/pad-osk-toggle.sh" \
   "$STAGE/usr/bin/pad-osk"

cp "$ROOT/scripts/pad-osk.desktop" \
   "$STAGE/usr/share/applications/pad-osk.desktop"

# Translations: compile po/<lang>.po into
# usr/share/gnome-shell/extensions/<uuid>/locale/<lang>/LC_MESSAGES/<uuid>.mo,
# which is where the extension's bindtextdomain() looks.  Needs msgfmt (gettext).
EXT_LOCALE="$STAGE/usr/share/gnome-shell/extensions/erhai-osk@local/locale"
if [ -d "$ROOT/po" ]; then
    command -v msgfmt >/dev/null 2>&1 || {
        echo "error: msgfmt not found (install gettext)" >&2
        exit 1
    }
    mkdir -p "$EXT_LOCALE"
    for po in "$ROOT"/po/*.po; do
        [ -e "$po" ] || continue
        lang=$(basename "$po" .po)
        mkdir -p "$EXT_LOCALE/$lang/LC_MESSAGES"
        msgfmt --check -o "$EXT_LOCALE/$lang/LC_MESSAGES/erhai-osk@local.mo" "$po"
        echo "locale: $lang"
    done
fi

# dpkg-deb preserves the tree's modes, so set them explicitly.
# The DEBIAN directory itself must be 0755: a tree that came in from Windows or
# from a FAT/exFAT volume arrives as 0707, and dpkg-deb refuses to build.
chmod 755 "$STAGE/DEBIAN"
chmod 755 "$STAGE/usr/bin/pad-osk"
chmod 755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/postrm"
chmod 644 "$STAGE/usr/share/applications/pad-osk.desktop"
chmod 644 "$STAGE/usr/share/gnome-shell/extensions/erhai-osk@local/"*.js \
          "$STAGE/usr/share/gnome-shell/extensions/erhai-osk@local/"*.json
find "$STAGE/usr/share/gnome-shell/extensions/erhai-osk@local/locale" \
     -name '*.mo' -exec chmod 644 {} + 2>/dev/null || true

echo "=== tree ==="
find "$STAGE" -path "$STAGE/DEBIAN" -prune -o -print | sed "s|$STAGE|.|" | sort

# The maintainer scripts carry the version literally (debhelper would do this
# via #VERSION#; we substitute by hand to avoid a debhelper dependency).
sed -i "s/@VERSION@/$VER/g" "$STAGE/DEBIAN/postinst"

echo "=== build $DEB ==="
dpkg-deb --build --root-owner-group "$STAGE" "$DEB"

echo "=== result ==="
ls -l "$DEB"
dpkg-deb --info "$DEB"
echo
dpkg-deb --contents "$DEB"
