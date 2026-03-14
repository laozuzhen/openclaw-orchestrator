import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sourceDir = resolve(repoRoot, 'extensions', 'openclaw-orchestrator');
const sourcePackageJsonPath = resolve(sourceDir, 'package.json');
const pluginId = 'openclaw-orchestrator';
const defaultBaseUrl = 'http://127.0.0.1:3721';
const defaultTimeoutMs = 15000;

function parseArgs(argv) {
  const result = {
    force: false,
    target: null,
    config: null,
    mode: null,
    baseUrl: null,
    authToken: null,
    timeoutMs: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      result.force = true;
      continue;
    }
    if (arg === '--target') {
      result.target = argv[index + 1] ? resolve(argv[index + 1]) : null;
      index += 1;
      continue;
    }
    if (arg === '--config') {
      result.config = argv[index + 1] ? resolve(argv[index + 1]) : null;
      index += 1;
      continue;
    }
    if (arg === '--mode') {
      result.mode = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--base-url') {
      result.baseUrl = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--auth-token') {
      result.authToken = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const raw = argv[index + 1] ?? null;
      result.timeoutMs = raw ? Number(raw) : null;
      index += 1;
      continue;
    }
  }
  return result;
}

function resolveDefaultTarget() {
  return resolve(os.homedir(), '.openclaw', 'extensions', pluginId);
}

function resolveDefaultConfigPath() {
  return resolve(os.homedir(), '.openclaw', 'openclaw.json');
}

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw);
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizePath(filePath) {
  return resolve(filePath);
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    const normalized = normalizePath(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function ensurePluginConfig(config, pluginPath, pluginVersion, args) {
  const nextConfig = config && typeof config === 'object' ? config : {};
  const plugins = nextConfig.plugins && typeof nextConfig.plugins === 'object' ? nextConfig.plugins : {};
  const load = plugins.load && typeof plugins.load === 'object' ? plugins.load : {};
  const entries = plugins.entries && typeof plugins.entries === 'object' ? plugins.entries : {};
  const installs = plugins.installs && typeof plugins.installs === 'object' ? plugins.installs : {};
  const allow = Array.isArray(plugins.allow) ? plugins.allow.slice() : [];

  const entry = entries[pluginId] && typeof entries[pluginId] === 'object' ? entries[pluginId] : {};
  const entryConfig = entry.config && typeof entry.config === 'object' ? entry.config : {};

  const mergedEntryConfig = {
    baseUrl: args.baseUrl ?? entryConfig.baseUrl ?? defaultBaseUrl,
    timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : entryConfig.timeoutMs ?? defaultTimeoutMs,
  };

  const authToken = args.authToken ?? entryConfig.authToken;
  if (authToken) {
    mergedEntryConfig.authToken = authToken;
  }

  entries[pluginId] = {
    ...entry,
    enabled: true,
    config: mergedEntryConfig,
  };

  installs[pluginId] = {
    source: 'path',
    installPath: pluginPath,
    version: pluginVersion,
    installedAt: new Date().toISOString(),
  };

  plugins.load = {
    ...load,
    paths: uniquePaths([...(Array.isArray(load.paths) ? load.paths : []), pluginPath]),
  };
  plugins.allow = Array.from(new Set([...allow, pluginId]));
  plugins.entries = entries;
  plugins.installs = installs;
  nextConfig.plugins = plugins;
  return nextConfig;
}

function installCopy(targetDir, force) {
  if (existsSync(targetDir)) {
    if (!force) {
      console.error(`Target already exists: ${targetDir}\nUse --force to overwrite.`);
      process.exit(1);
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (entry) => !entry.includes(`${sourceDir}${pathSeparator()}node_modules`),
  });
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

if (!existsSync(sourceDir)) {
  console.error(`Plugin source not found: ${sourceDir}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? (args.target ? 'copy' : 'dev');

if (!['dev', 'copy'].includes(mode)) {
  console.error(`Unsupported mode: ${mode}. Expected one of: dev, copy.`);
  process.exit(1);
}

if (args.timeoutMs !== null && !Number.isFinite(args.timeoutMs)) {
  console.error(`Invalid --timeout-ms value: ${args.timeoutMs}`);
  process.exit(1);
}

const pluginPackage = readJsonFile(sourcePackageJsonPath, {});
const pluginVersion = typeof pluginPackage.version === 'string' ? pluginPackage.version : '0.0.0';
const targetDir = args.target ?? resolveDefaultTarget();
const pluginPath = mode === 'copy' ? targetDir : sourceDir;
const configPath = args.config ?? resolveDefaultConfigPath();

if (mode === 'copy') {
  installCopy(targetDir, args.force);
}

const currentConfig = readJsonFile(configPath, {});
const nextConfig = ensurePluginConfig(currentConfig, pluginPath, pluginVersion, args);
writeJsonFile(configPath, nextConfig);

if (mode === 'dev') {
  console.log(`Registered development plugin path in ${configPath}`);
  console.log(`Plugin path: ${pluginPath}`);
  console.log(`Base URL: ${nextConfig.plugins.entries[pluginId].config.baseUrl}`);
  console.log('Changes in this repository now take effect immediately after OpenClaw reloads plugins.');
} else {
  console.log(`Installed openclaw-orchestrator plugin to ${targetDir}`);
  console.log(`Registered copied plugin path in ${configPath}`);
  console.log('If your OpenClaw extension loader does not install dependencies automatically, run npm install --omit=dev inside the copied plugin directory.');
}
