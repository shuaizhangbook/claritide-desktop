#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 && $(uname -s) == Darwin ]] || { echo 'usage: package-macos.sh <activitywatch> <sync-binary> (macOS only)' >&2; exit 2; }
cd "$1"
sync_binary=$2
version=$(python3 -c 'import json; print(json.load(open("aw-tauri/src-tauri/tauri.conf.json"))["version"])')
arch=$(uname -m)
[[ "$version" == 0.2.2 ]]
test -x "$sync_binary"
# Reuse upstream's collector layout and Python framework normalization.
APPLE_PERSONALID='' bash scripts/package/build_app_tauri.sh
app=dist/Claritide.app
test ! -e "$app"
mv dist/ActivityWatch.app "$app"
cp "$sync_binary" "$app/Contents/MacOS/seeseeyou-sync"
cp -R aw-tauri/src-tauri/agent-runtime "$app/Contents/Resources/agent-runtime"
python3 - "$app/Contents/Info.plist" "$version" <<'PY'
import plistlib,sys
path,version=sys.argv[1:]
with open(path,'rb') as f: p=plistlib.load(f)
p.update(CFBundleName='Claritide',CFBundleDisplayName='Claritide',CFBundleIdentifier='com.seeseeyou.desktop',CFBundleVersion=version,CFBundleShortVersionString=version,NSAppleEventsUsageDescription='Claritide uses Accessibility permission to record the active application and idle status on this Mac.')
with open(path,'wb') as f: plistlib.dump(p,f)
PY
for binary in "$app/Contents/MacOS/aw-tauri" "$app/Contents/MacOS/seeseeyou-sync" "$app/Contents/Resources/agent-runtime/node/bin/node"; do
  test -x "$binary"
  lipo -verify_arch "$arch" "$binary"
done
test -f "$app/Contents/Resources/agent-runtime/ccb/dist/cli-node.js"
test -f "$app/Contents/Resources/agent-runtime/manifest.json"
test -d "$app/Contents/Resources/aw-watcher-window"
test -d "$app/Contents/Resources/aw-watcher-afk"
"$app/Contents/MacOS/seeseeyou-sync" --help
"$app/Contents/Resources/agent-runtime/node/bin/node" "$app/Contents/Resources/agent-runtime/ccb/dist/cli-node.js" --version
# Ad-hoc signing is for testing; this is not Developer ID signing/notarization.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
base="Claritide-$version-macos-$arch"
ditto -c -k --sequesterRsrc --keepParent "$app" "dist/$base.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Claritide.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "Claritide $version" -srcfolder "$stage" -ov -format UDZO "dist/$base.dmg"
hdiutil verify "dist/$base.dmg"
(cd dist && shasum -a 256 "$base.dmg" "$base.zip" > "$base.sha256")
