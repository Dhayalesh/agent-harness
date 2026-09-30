/**
 * Build script for Standalone SAP ADT MCP Host (sap-adt-host.exe)
 *
 * Automates:
 * 1. Bundling host.js + dependencies via esbuild into bundle.cjs
 * 2. Generating Node SEA blob via node --experimental-sea-config
 * 3. Copying host Node executable
 * 4. Stripping PE Authenticode digital signature
 * 5. Injecting SEA blob via postject into sap-adt-host.exe
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findEsbuild() {
  const candidates = [
    path.resolve(__dirname, '../../mcp-abap-adt/node_modules/tsx/node_modules/esbuild/node_modules/@esbuild/win32-x64/esbuild.exe'),
    path.resolve(process.env.APPDATA || '', 'npm/node_modules/esbuild/esbuild.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('esbuild.exe not found in candidate paths');
}

function stripAuthenticodeSignature(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  const buffer = Buffer.alloc(1024);
  fs.readSync(fd, buffer, 0, 1024, 0);

  if (buffer.readUInt16LE(0) !== 0x5A4D) {
    fs.closeSync(fd);
    throw new Error('Not an MZ executable');
  }

  const peOffset = buffer.readUInt32LE(0x3C);
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) {
    fs.closeSync(fd);
    throw new Error('Not a valid PE header');
  }

  const secDirOffset = peOffset + 24 + 144;
  const secRva = buffer.readUInt32LE(secDirOffset);
  const secSize = buffer.readUInt32LE(secDirOffset + 4);

  if (secSize > 0 && secRva > 0) {
    const zeroBuf = Buffer.alloc(8);
    fs.writeSync(fd, zeroBuf, 0, 8, secDirOffset);
    fs.ftruncateSync(fd, secRva);
    console.log(`[build] Stripped signature: 0x${secSize.toString(16)} bytes removed at offset 0x${secRva.toString(16)}`);
  } else {
    console.log('[build] Binary has no signature or signature is already stripped.');
  }

  fs.closeSync(fd);
}

function main() {
  const dir = __dirname;
  console.log('[build] Starting build of sap-adt-host.exe...');

  // 1. Bundle with esbuild
  const esbuild = findEsbuild();
  const hostJs = path.join(dir, 'host.js');
  const bundleCjs = path.join(dir, 'bundle.cjs');
  console.log(`[build] Bundling ${hostJs} -> ${bundleCjs} using ${esbuild}`);

  execSync(`"${esbuild}" "${hostJs}" --bundle --platform=node --target=node22 --format=cjs --external:kerberos --outfile="${bundleCjs}"`, {
    stdio: 'inherit',
    cwd: dir,
  });

  // 2. Prepare SEA config
  const seaConfigPath = path.join(dir, 'sea-config.json');
  const seaConfig = {
    main: 'bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  // 3. Generate SEA blob
  console.log('[build] Generating SEA blob...');
  execSync('node --experimental-sea-config sea-config.json', {
    stdio: 'inherit',
    cwd: dir,
  });

  // 4. Copy Node binary
  const nodeBin = process.execPath;
  const targetExe = path.join(dir, 'sap-adt-host.exe');
  console.log(`[build] Copying ${nodeBin} -> ${targetExe}`);
  fs.copyFileSync(nodeBin, targetExe);

  // 5. Strip Authenticode signature
  console.log('[build] Stripping Authenticode signature from executable...');
  stripAuthenticodeSignature(targetExe);

  // 6. Inject blob with postject
  console.log('[build] Injecting SEA blob via postject...');
  execSync(`npx --yes postject "${targetExe}" NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, {
    stdio: 'inherit',
    cwd: dir,
  });

  const stat = fs.statSync(targetExe);
  console.log(`[build] SUCCESS: Built sap-adt-host.exe (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

main();

