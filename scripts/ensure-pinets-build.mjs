import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(projectRoot, 'vendor', 'pinets');
const stampPath = path.join(vendorRoot, 'dist', '.pine-strategy-runner-source.sha256');
const dependencyStampPath = path.join(vendorRoot, 'dist', '.pine-strategy-runner-dependencies.sha256');
const requiredOutputs = [
  'dist/pinets.min.cjs',
  'dist/pinets.min.es.js',
  'dist/pinets.min.browser.js',
  'dist/pinets.min.browser.es.js',
  'dist/types/index.d.ts',
];
const inputRoots = ['src', 'scripts'];
const inputFiles = [
  'package.json',
  'package-lock.json',
  'rollup.config.js',
  'tsconfig.json',
  'tsconfig.dts.json',
];

async function collectFiles(relativePath) {
  const absolutePath = path.join(vendorRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relativePath.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function sourceHash() {
  const files = [...inputFiles];
  for (const root of inputRoots) files.push(...await collectFiles(root));
  files.sort();
  const hash = createHash('sha256');
  hash.update('pine-strategy-runner-pinets-build-v1\0');
  for (const file of files) {
    hash.update(file.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path.join(vendorRoot, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function dependencyHash() {
  const hash = createHash('sha256');
  hash.update('pine-strategy-runner-pinets-dependencies-v1\0');
  for (const file of ['package.json', 'package-lock.json']) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(path.join(vendorRoot, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function exists(relativePath) {
  try {
    await access(path.join(vendorRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: vendorRoot, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd: vendorRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
  if (result.status !== 0) {
    throw new Error(
      `PineTS build command failed: npm ${args.join(' ')}${result.error ? ` (${result.error.message})` : ''}`,
    );
  }
}

const rollupExecutable = process.platform === 'win32'
  ? 'node_modules/.bin/rollup.cmd'
  : 'node_modules/.bin/rollup';
const expectedDependencyHash = await dependencyHash();
const currentDependencyStamp = await readFile(dependencyStampPath, 'utf8').catch(() => '');
if (currentDependencyStamp.trim() !== expectedDependencyHash || !await exists(rollupExecutable)) {
  console.log('Installing the pinned PineTS build dependencies...');
  runNpm(['ci', '--include=dev', '--ignore-scripts']);
  await mkdir(path.dirname(dependencyStampPath), { recursive: true });
  await writeFile(dependencyStampPath, `${expectedDependencyHash}\n`, 'utf8');
}

const expectedHash = await sourceHash();
const currentStamp = await readFile(stampPath, 'utf8').catch(() => '');
const hasOutputs = (await Promise.all(requiredOutputs.map(exists))).every(Boolean);
if (currentStamp.trim() === expectedHash && hasOutputs) {
  console.log('PineTS vendor build is current.');
  process.exit(0);
}

console.log('Building PineTS from the tracked vendor source...');
runNpm(['run', 'build:prod:all']);
await mkdir(path.dirname(stampPath), { recursive: true });
await writeFile(stampPath, `${await sourceHash()}\n`, 'utf8');
console.log('PineTS vendor build completed.');
