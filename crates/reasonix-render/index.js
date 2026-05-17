// Native module loader — cascades per-platform optional-dep packages,
// matching what `napi build --platform --js index.js` would auto-generate
// (we hand-wrote it because napi-derive 2's type-def auto-extraction
// wasn't firing reliably in our workspace setup; tracked in followup).
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const triples = {
  "win32 x64 msvc": "@reasonix/render-native-win32-x64-msvc",
  "linux x64 glibc": "@reasonix/render-native-linux-x64-gnu",
  "linux arm64 glibc": "@reasonix/render-native-linux-arm64-gnu",
  "darwin x64": "@reasonix/render-native-darwin-x64",
  "darwin arm64": "@reasonix/render-native-darwin-arm64",
};

function platformKey() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "win32") return `win32 ${arch} msvc`;
  if (plat === "linux") {
    // libc detection: musl ships statically-linked, glibc dynamically — we
    // only publish glibc subpackages today, so just claim glibc for any linux.
    return `linux ${arch} glibc`;
  }
  return `${plat} ${arch}`;
}

const key = platformKey();
const pkgName = triples[key];

let native = null;

// 1) Try the published subpackage (production path: npm-installed sibling).
if (pkgName) {
  try {
    native = require(pkgName);
  } catch (err) {
    // fall through to local dev path
  }
}

// 2) Local dev: built by `napi build --platform` into the crate dir.
if (!native) {
  const localName = `reasonix-render.${key.replace(/ /g, "-")}.node`;
  const localPath = join(__dirname, localName);
  if (existsSync(localPath)) {
    native = require(localPath);
  }
}

if (!native) {
  throw new Error(
    `@reasonix/render-native: no compiled binary for ${process.platform}-${process.arch}. ` +
      `Expected '${pkgName ?? "<unsupported platform>"}' or a local 'reasonix-render.${key.replace(/ /g, "-")}.node'.`,
  );
}

module.exports = native;
