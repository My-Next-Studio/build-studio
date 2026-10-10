const fs = require('fs');
const path = require('path');
const { BUILD_STUDIO_DIR, REGISTRY_PATH, DEFAULT_PROJECT_PORT_START } = require('./constants');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir(BUILD_STUDIO_DIR);
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { version: 1, projects: {} };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function save(registry) {
  ensureDir(BUILD_STUDIO_DIR);
  const tmp = REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

/**
 * The project's port: the top-level `port:` key in its .build-studio/config.yaml,
 * or null when the file or the key is missing.
 *
 * That key is the one source of a project's port. Other Studio apps find the
 * project server from it (docs/backlog-api-contract.md §1), so every reader
 * here returns it over the port stored in the registry, which stays only as
 * the fallback for a project without the key.
 */
function configPort(projectPath) {
  try {
    const text = fs.readFileSync(path.join(projectPath, '.build-studio', 'config.yaml'), 'utf8');
    const m = text.match(/^port:[ \t]*(\d+)[ \t]*(?:#.*)?$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function entry(name, info) {
  return { name, ...info, port: configPort(info.path) ?? info.port };
}

function list() {
  const reg = load();
  return Object.entries(reg.projects).map(([name, info]) => entry(name, info));
}

function get(name) {
  const reg = load();
  const info = reg.projects[name];
  return info ? entry(name, info) : null;
}

function add(name, projectPath, port, workspace = null) {
  const reg = load();
  reg.projects[name] = {
    path: projectPath,
    port,
    ...(workspace ? { workspace } : {}),
    addedAt: new Date().toISOString(),
  };
  save(reg);
  return reg.projects[name];
}

/**
 * List projects grouped by workspace. Projects with no workspace go in the
 * default group (null key).
 */
function listByWorkspace() {
  const all = list();
  const groups = new Map();
  for (const p of all) {
    const ws = p.workspace || null;
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(p);
  }
  return groups;
}

/**
 * Check for name collision — returns existing entry if a project with the
 * same name (but possibly a different workspace) exists.
 */
function findByName(name) {
  return get(name);
}

function remove(name) {
  const reg = load();
  if (!reg.projects[name]) return false;
  delete reg.projects[name];
  save(reg);
  return true;
}

function nextAvailablePort() {
  const usedPorts = list().map(p => p.port);
  let port = DEFAULT_PROJECT_PORT_START;
  while (usedPorts.includes(port)) port++;
  return port;
}

/**
 * Find a project by path (for registering existing projects).
 */
function findByPath(projectPath) {
  const reg = load();
  const resolved = path.resolve(projectPath);
  for (const [name, info] of Object.entries(reg.projects)) {
    if (path.resolve(info.path) === resolved) return entry(name, info);
  }
  return null;
}

module.exports = { load, save, list, get, add, remove, nextAvailablePort, findByPath, listByWorkspace, findByName, configPort };
