const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const installerPath = process.env.CLARITIDE_INSTALLER_SCRIPT;
if (!installerPath) {
  throw new Error('CLARITIDE_INSTALLER_SCRIPT must point to aw-tauri.iss');
}

const installer = fs.readFileSync(installerPath, 'utf8');

test('Windows installer persists the selected app language', () => {
  assert.match(installer, /CompareText\(ActiveLanguage, 'english'\)/);
  assert.match(installer, /AppLanguage := 'en'/);
  assert.match(installer, /AppLanguage := 'zh-CN'/);
  assert.match(installer, /claritide-installer-language\.txt/);
  assert.match(installer, /SaveStringToFile/);
});

test('Windows installer embeds the target desktop version', () => {
  assert.match(installer, /^#define MyAppVersion "0\.2\.2"\r?$/m);
});
