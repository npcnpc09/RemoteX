/**
 * RemoteX SSH Bridge
 *
 * Provides Claude Code with programmatic SSH access to all servers.
 * Direct SSH mode via ssh2 library.
 */

import { Client as SSHClient } from 'ssh2';
import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ═══════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════

const CONFIG_PATH = join(homedir(), '.remotex.json');

const DEFAULT_CONFIG = {
  mode: 'direct',
  servers: {},
  // Example server entry:
  // "prod-01": { host: "10.0.1.1", port: 22, username: "root", privateKey: "~/.ssh/id_rsa" }
};

export function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch { return { ...DEFAULT_CONFIG }; }
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ═══════════════════════════════════════════════════
// SSH Direct Connection Pool
// ═══════════════════════════════════════════════════

const connectionPool = new Map(); // serverId -> { conn, lastUsed }

function resolveKeyPath(p) {
  if (!p) return null;
  if (p.startsWith('~')) p = join(homedir(), p.slice(1));
  if (existsSync(p)) return readFileSync(p);
  return null;
}

async function getConnection(serverId, serverConfig) {
  const existing = connectionPool.get(serverId);
  if (existing && existing.conn._sock && !existing.conn._sock.destroyed) {
    existing.lastUsed = Date.now();
    return existing.conn;
  }

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const opts = {
      host: serverConfig.host,
      port: serverConfig.port || 22,
      username: serverConfig.username || 'root',
      readyTimeout: 3000,
    };

    if (serverConfig.privateKey) {
      opts.privateKey = resolveKeyPath(serverConfig.privateKey);
    } else if (serverConfig.password) {
      opts.password = serverConfig.password;
    } else {
      // Try default keys
      for (const k of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
        const key = resolveKeyPath(join('~', '.ssh', k));
        if (key) { opts.privateKey = key; break; }
      }
    }

    conn.on('ready', () => {
      connectionPool.set(serverId, { conn, lastUsed: Date.now() });
      resolve(conn);
    });
    conn.on('error', (err) => {
      connectionPool.delete(serverId);
      reject(err);
    });
    conn.connect(opts);
  });
}

// Clean idle connections every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, { conn, lastUsed }] of connectionPool) {
    if (now - lastUsed > 300000) {
      conn.end();
      connectionPool.delete(id);
    }
  }
}, 60000);

// ═══════════════════════════════════════════════════
// Core Operations
// ═══════════════════════════════════════════════════

/**
 * Execute a command on a server. Returns { stdout, stderr, code }.
 */
export async function execCommand(serverId, command, timeoutMs = 30000) {
  const config = loadConfig();
  const server = config.servers[serverId];
  if (!server) throw new Error(`Server "${serverId}" not found. Use "remotex add" to add it.`);

  const conn = await getConnection(serverId, server);

  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); reject(err); return; }

      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code || 0 });
      });
    });
  });
}

/**
 * Execute a command on multiple servers in parallel.
 */
export async function execBatch(serverIds, command, concurrency = 10) {
  const results = {};
  const chunks = [];
  for (let i = 0; i < serverIds.length; i += concurrency) {
    chunks.push(serverIds.slice(i, i + concurrency));
  }

  for (const chunk of chunks) {
    const promises = chunk.map(async (id) => {
      try {
        results[id] = await execCommand(id, command);
      } catch (err) {
        results[id] = { stdout: '', stderr: err.message, code: -1 };
      }
    });
    await Promise.all(promises);
  }
  return results;
}

/**
 * Get server system info (CPU, memory, disk, uptime, OS).
 */
export async function getServerInfo(serverId) {
  const commands = {
    hostname: 'hostname',
    uptime: 'uptime -p 2>/dev/null || uptime',
    os: 'cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"',
    kernel: 'uname -r',
    cpu_cores: 'nproc',
    cpu_usage: "top -bn1 | grep 'Cpu(s)' | awk '{print $2}'",
    mem_total: "free -m | awk '/Mem:/{print $2}'",
    mem_used: "free -m | awk '/Mem:/{print $3}'",
    mem_percent: "free | awk '/Mem:/{printf \"%.1f\", $3/$2*100}'",
    disk_total: "df -h / | awk 'NR==2{print $2}'",
    disk_used: "df -h / | awk 'NR==2{print $3}'",
    disk_percent: "df -h / | awk 'NR==2{print $5}'",
    load: 'cat /proc/loadavg | cut -d" " -f1-3',
    ip: "hostname -I | awk '{print $1}'",
    docker_running: 'docker ps -q 2>/dev/null | wc -l',
    listening_ports: "ss -tlnp 2>/dev/null | awk 'NR>1{print $4}' | grep -oP ':\\K[0-9]+' | sort -un | head -20 | tr '\\n' ','",
  };

  const bigCmd = Object.entries(commands)
    .map(([key, cmd]) => `echo "___${key}___"; ${cmd} 2>/dev/null || echo ""`)
    .join('; ');

  const result = await execCommand(serverId, bigCmd, 15000);
  const info = {};
  const sections = result.stdout.split(/___(\w+)___/).filter(Boolean);
  for (let i = 0; i < sections.length - 1; i += 2) {
    info[sections[i]] = sections[i + 1].trim();
  }
  return info;
}

/**
 * List all configured servers with their live status.
 */
export async function listServers(checkAlive = false) {
  const config = loadConfig();
  const servers = [];

  for (const [id, srv] of Object.entries(config.servers)) {
    const entry = { id, host: srv.host, port: srv.port || 22, username: srv.username, group: srv.group || 'default' };

    if (checkAlive) {
      try {
        const r = await execCommand(id, 'echo ok', 5000);
        entry.status = r.code === 0 ? 'online' : 'error';
      } catch {
        entry.status = 'offline';
      }
    } else {
      entry.status = 'unknown';
    }
    servers.push(entry);
  }
  return servers;
}

/**
 * List servers by group.
 */
export function listGroups() {
  const config = loadConfig();
  const groups = {};
  for (const [id, srv] of Object.entries(config.servers)) {
    const g = srv.group || 'default';
    if (!groups[g]) groups[g] = [];
    groups[g].push(id);
  }
  return groups;
}

/**
 * Add a server to config.
 */
export function addServer(id, host, opts = {}) {
  const config = loadConfig();
  config.servers[id] = {
    host,
    port: opts.port || 22,
    username: opts.username || 'root',
    privateKey: opts.privateKey || '',
    password: opts.password || '',
    group: opts.group || 'default',
  };
  saveConfig(config);
  return config.servers[id];
}

/**
 * Remove a server.
 */
export function removeServer(id) {
  const config = loadConfig();
  delete config.servers[id];
  if (connectionPool.has(id)) {
    connectionPool.get(id).conn.end();
    connectionPool.delete(id);
  }
  saveConfig(config);
}

/**
 * Upload a file to remote server.
 */
export async function uploadFile(serverId, localPath, remotePath) {
  const config = loadConfig();
  const server = config.servers[serverId];
  if (!server) throw new Error(`Server "${serverId}" not found`);

  const conn = await getConnection(serverId, server);
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const rs = sftp.createReadStream ? null : null; // Use fastPut
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) reject(err);
        else resolve({ ok: true, path: remotePath });
      });
    });
  });
}

/**
 * Download a file from remote server.
 */
export async function downloadFile(serverId, remotePath, localPath) {
  const config = loadConfig();
  const server = config.servers[serverId];
  if (!server) throw new Error(`Server "${serverId}" not found`);

  const conn = await getConnection(serverId, server);
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) reject(err);
        else resolve({ ok: true, path: localPath });
      });
    });
  });
}

/**
 * Tail a log file on a remote server (returns last N lines).
 */
export async function tailLog(serverId, logPath, lines = 50) {
  return execCommand(serverId, `tail -n ${lines} ${logPath}`);
}

/**
 * Check if a service is running.
 */
export async function checkService(serverId, serviceName) {
  const r = await execCommand(serverId, `systemctl is-active ${serviceName} 2>/dev/null || service ${serviceName} status 2>/dev/null`);
  return {
    service: serviceName,
    active: r.stdout.includes('active') || r.code === 0,
    output: r.stdout,
  };
}

/**
 * Manage a service (start/stop/restart/status).
 */
export async function manageService(serverId, serviceName, action) {
  if (!['start', 'stop', 'restart', 'status', 'enable', 'disable'].includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
  return execCommand(serverId, `sudo systemctl ${action} ${serviceName}`);
}

/**
 * Get all listening ports with process info.
 */
export async function getListeningPorts(serverId) {
  const r = await execCommand(serverId, "ss -tlnp | awk 'NR>1{print $4, $6}'");
  const ports = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [addr, proc] = line.split(/\s+/);
    const port = addr.split(':').pop();
    const match = proc?.match(/users:\(\("([^"]+)",pid=(\d+)/);
    ports.push({
      port: parseInt(port),
      address: addr,
      process: match ? match[1] : '',
      pid: match ? parseInt(match[2]) : 0,
    });
  }
  return ports;
}

/**
 * Open an interactive shell session on a server.
 * Returns { stream, close } — stream is a duplex stream.
 * Caller writes input to stream, reads output from stream.
 */
export async function openShell(serverId, opts = {}) {
  const config = loadConfig();
  const server = config.servers[serverId];
  if (!server) throw new Error(`Server "${serverId}" not found`);

  const conn = await getConnection(serverId, server);
  const { cols = 120, rows = 30 } = opts;

  return new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) return reject(err);
      resolve({
        stream,
        resize(cols, rows) {
          stream.setWindow(rows, cols, 0, 0);
        },
        close() {
          stream.end();
        }
      });
    });
  });
}

/**
 * Disconnect all connections.
 */
export function disconnectAll() {
  for (const [id, { conn }] of connectionPool) {
    conn.end();
  }
  connectionPool.clear();
}

// ═══════════════════════════════════════════════════
// Remote File Operations — Claude Code 远程开发核心
// ═══════════════════════════════════════════════════

/**
 * Read a file from remote server. Returns file content as string.
 * Supports optional line range for large files.
 */
export async function readFile(serverId, remotePath, opts = {}) {
  const { startLine, endLine, maxBytes = 1024 * 1024 } = opts;

  let cmd;
  if (startLine && endLine) {
    cmd = `sed -n '${startLine},${endLine}p' ${JSON.stringify(remotePath)}`;
  } else if (startLine) {
    cmd = `tail -n +${startLine} ${JSON.stringify(remotePath)}`;
  } else {
    // Read with size guard
    cmd = `stat -c%s ${JSON.stringify(remotePath)} 2>/dev/null; cat ${JSON.stringify(remotePath)}`;
  }

  const r = await execCommand(serverId, cmd, 30000);
  if (r.code !== 0) {
    throw new Error(`Failed to read ${remotePath}: ${r.stderr}`);
  }

  // If we got stat output first, check file size
  const lines = r.stdout.split('\n');
  const firstLine = lines[0];
  if (/^\d+$/.test(firstLine) && !startLine) {
    const fileSize = parseInt(firstLine);
    if (fileSize > maxBytes) {
      return {
        content: lines.slice(1).join('\n'),
        truncated: true,
        size: fileSize,
        warning: `File is ${(fileSize / 1024).toFixed(1)}KB. Content may be truncated. Use startLine/endLine for large files.`,
      };
    }
    return { content: lines.slice(1).join('\n'), truncated: false, size: fileSize };
  }

  return { content: r.stdout, truncated: false };
}

/**
 * Write content to a remote file. Creates parent dirs if needed.
 * Supports three modes:
 *   - 'overwrite' (default): replace entire file
 *   - 'append': append to end
 *   - 'insert': insert at a specific line number
 */
export async function writeFile(serverId, remotePath, content, opts = {}) {
  const { mode = 'overwrite', insertAtLine, backup = true, createDirs = true, permissions } = opts;

  const cmds = [];

  // Create parent directories if needed
  if (createDirs) {
    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    if (dir) cmds.push(`mkdir -p ${JSON.stringify(dir)}`);
  }

  // Backup original file
  if (backup) {
    cmds.push(`[ -f ${JSON.stringify(remotePath)} ] && cp ${JSON.stringify(remotePath)} ${JSON.stringify(remotePath + '.bak')} || true`);
  }

  // Escape content for heredoc — use base64 to handle any content safely
  const b64 = Buffer.from(content, 'utf-8').toString('base64');

  if (mode === 'overwrite') {
    cmds.push(`echo '${b64}' | base64 -d > ${JSON.stringify(remotePath)}`);
  } else if (mode === 'append') {
    cmds.push(`echo '${b64}' | base64 -d >> ${JSON.stringify(remotePath)}`);
  } else if (mode === 'insert' && insertAtLine) {
    // Write to temp, then use sed to insert
    cmds.push(`echo '${b64}' | base64 -d > /tmp/_tcc_insert_$$`);
    cmds.push(`sed -i '${insertAtLine}r /tmp/_tcc_insert_$$' ${JSON.stringify(remotePath)}`);
    cmds.push(`rm -f /tmp/_tcc_insert_$$`);
  }

  // Set permissions if specified
  if (permissions) {
    cmds.push(`chmod ${permissions} ${JSON.stringify(remotePath)}`);
  }

  const fullCmd = cmds.join(' && ');
  const r = await execCommand(serverId, fullCmd, 30000);

  if (r.code !== 0) {
    throw new Error(`Failed to write ${remotePath}: ${r.stderr}`);
  }

  return { ok: true, path: remotePath, mode, backedUp: backup };
}

/**
 * Replace text in a remote file (like str_replace / sed).
 * Finds `oldText` and replaces with `newText`.
 */
export async function replaceInFile(serverId, remotePath, oldText, newText, opts = {}) {
  const { backup = true, all = false } = opts;

  // Read the file
  const { content } = await readFile(serverId, remotePath);

  if (!content.includes(oldText)) {
    throw new Error(`Text not found in ${remotePath}: "${oldText.substring(0, 80)}..."`);
  }

  // Count occurrences
  const count = content.split(oldText).length - 1;
  if (count > 1 && !all) {
    throw new Error(`Found ${count} occurrences of the text. Use all:true to replace all, or be more specific.`);
  }

  // Replace
  const newContent = all ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);

  // Write back
  await writeFile(serverId, remotePath, newContent, { backup, createDirs: false });

  return { ok: true, path: remotePath, replacements: all ? count : 1 };
}

/**
 * List directory contents on a remote server.
 * Returns structured file/dir listing with metadata.
 */
export async function listDir(serverId, remotePath, opts = {}) {
  const { recursive = false, maxDepth = 3, showHidden = false, pattern = '' } = opts;

  let cmd;
  if (recursive) {
    // Tree-like listing with find
    const hiddenFlag = showHidden ? '' : "-not -path '*/.*'";
    const patternFlag = pattern ? `-name ${JSON.stringify(pattern)}` : '';
    cmd = `find ${JSON.stringify(remotePath)} -maxdepth ${maxDepth} ${hiddenFlag} ${patternFlag} -printf '%y %m %u %s %T@ %p\\n' 2>/dev/null | sort -k6`;
  } else {
    const hiddenFlag = showHidden ? '-la' : '-l';
    cmd = `ls ${hiddenFlag} --time-style=long-iso ${JSON.stringify(remotePath)} 2>/dev/null`;
  }

  const r = await execCommand(serverId, cmd, 15000);
  if (r.code !== 0) {
    throw new Error(`Failed to list ${remotePath}: ${r.stderr}`);
  }

  if (recursive) {
    // Parse find output
    const entries = [];
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        const [type, perms, owner, size, mtime, ...pathParts] = parts;
        const fullPath = pathParts.join(' ');
        entries.push({
          type: type === 'd' ? 'directory' : 'file',
          permissions: perms,
          owner,
          size: parseInt(size),
          path: fullPath,
          name: fullPath.split('/').pop(),
          depth: fullPath.replace(remotePath, '').split('/').filter(Boolean).length,
        });
      }
    }
    return { path: remotePath, entries, recursive: true };
  } else {
    // Parse ls -l output
    const entries = [];
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      if (line.startsWith('total ')) continue;
      const match = line.match(/^([drwxlsStT\-]{10})\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+)\s+(.+)$/);
      if (match) {
        const [, perms, owner, group, size, mtime, name] = match;
        entries.push({
          type: perms[0] === 'd' ? 'directory' : perms[0] === 'l' ? 'symlink' : 'file',
          permissions: perms,
          owner, group,
          size: parseInt(size),
          modified: mtime,
          name,
        });
      }
    }
    return { path: remotePath, entries, recursive: false };
  }
}

/**
 * Search for files by name or content (grep/find).
 */
export async function findFiles(serverId, searchPath, opts = {}) {
  const { namePattern, contentPattern, fileType, maxResults = 50, maxDepth = 10 } = opts;

  let cmd;
  if (contentPattern) {
    // grep for content within files
    const fileTypeFlag = fileType ? `--include=${JSON.stringify(fileType)}` : '';
    cmd = `grep -rn ${fileTypeFlag} --max-count=5 -l ${JSON.stringify(contentPattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -${maxResults}`;

    const r = await execCommand(serverId, cmd, 30000);
    const files = r.stdout.split('\n').filter(Boolean);

    // Get matching lines for each file
    if (files.length > 0) {
      const detailCmd = `grep -rn ${fileTypeFlag} --max-count=3 ${JSON.stringify(contentPattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -${maxResults * 3}`;
      const detail = await execCommand(serverId, detailCmd, 30000);
      const matches = [];
      for (const line of detail.stdout.split('\n').filter(Boolean)) {
        const colonIdx = line.indexOf(':');
        const secondColon = line.indexOf(':', colonIdx + 1);
        if (colonIdx > 0 && secondColon > 0) {
          matches.push({
            file: line.substring(0, colonIdx),
            line: parseInt(line.substring(colonIdx + 1, secondColon)),
            content: line.substring(secondColon + 1).trim(),
          });
        }
      }
      return { query: contentPattern, type: 'content', matches, fileCount: files.length };
    }
    return { query: contentPattern, type: 'content', matches: [], fileCount: 0 };

  } else if (namePattern) {
    // find by filename
    cmd = `find ${JSON.stringify(searchPath)} -maxdepth ${maxDepth} -name ${JSON.stringify(namePattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -${maxResults}`;
    const r = await execCommand(serverId, cmd, 15000);
    const files = r.stdout.split('\n').filter(Boolean);
    return { query: namePattern, type: 'name', files, count: files.length };

  } else {
    throw new Error('Specify namePattern or contentPattern');
  }
}

/**
 * Get file metadata (stat).
 */
export async function statFile(serverId, remotePath) {
  const cmd = `stat --format='{"size":%s,"perms":"%a","owner":"%U","group":"%G","modified":"%y","type":"%F"}' ${JSON.stringify(remotePath)} 2>/dev/null`;
  const r = await execCommand(serverId, cmd, 5000);
  if (r.code !== 0) {
    throw new Error(`File not found: ${remotePath}`);
  }
  try {
    const info = JSON.parse(r.stdout.trim());
    info.path = remotePath;
    return info;
  } catch {
    return { path: remotePath, raw: r.stdout };
  }
}

/**
 * Create a directory on remote server.
 */
export async function mkDir(serverId, remotePath, opts = {}) {
  const { permissions } = opts;
  let cmd = `mkdir -p ${JSON.stringify(remotePath)}`;
  if (permissions) cmd += ` && chmod ${permissions} ${JSON.stringify(remotePath)}`;
  const r = await execCommand(serverId, cmd, 5000);
  if (r.code !== 0) throw new Error(`Failed to create directory: ${r.stderr}`);
  return { ok: true, path: remotePath };
}

/**
 * Delete a file or directory on remote server.
 */
export async function deleteFile(serverId, remotePath, opts = {}) {
  const { recursive = false, force = false } = opts;
  // Safety: refuse to delete dangerous paths
  const dangerous = ['/', '/etc', '/usr', '/var', '/home', '/root', '/boot', '/bin', '/sbin', '/lib'];
  if (dangerous.includes(remotePath) || remotePath.length < 4) {
    throw new Error(`Refusing to delete dangerous path: ${remotePath}`);
  }
  const flags = `${recursive ? '-r' : ''} ${force ? '-f' : ''}`.trim();
  const cmd = `rm ${flags} ${JSON.stringify(remotePath)}`;
  const r = await execCommand(serverId, cmd, 10000);
  if (r.code !== 0) throw new Error(`Failed to delete: ${r.stderr}`);
  return { ok: true, deleted: remotePath };
}

/**
 * Move/rename a file on remote server.
 */
export async function moveFile(serverId, fromPath, toPath) {
  const r = await execCommand(serverId, `mv ${JSON.stringify(fromPath)} ${JSON.stringify(toPath)}`, 10000);
  if (r.code !== 0) throw new Error(`Failed to move: ${r.stderr}`);
  return { ok: true, from: fromPath, to: toPath };
}

/**
 * Copy a file on remote server.
 */
export async function copyFile(serverId, fromPath, toPath, opts = {}) {
  const { recursive = false } = opts;
  const flags = recursive ? '-r' : '';
  const r = await execCommand(serverId, `cp ${flags} ${JSON.stringify(fromPath)} ${JSON.stringify(toPath)}`, 10000);
  if (r.code !== 0) throw new Error(`Failed to copy: ${r.stderr}`);
  return { ok: true, from: fromPath, to: toPath };
}

// ═══════════════════════════════════════════════════
// Batch Import — 从 ip.txt 格式批量导入
// ═══════════════════════════════════════════════════

/**
 * Import servers from a text file (ip.txt format).
 * Each line: name,host,port,username,password,group
 * Lines starting with # are comments.
 * Returns { imported, skipped, errors }.
 */
export function importServersFromFile(filePath, opts = {}) {
  const { overwrite = false, defaultGroup = 'imported' } = opts;
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const config = loadConfig();
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  let imported = 0, skipped = 0;
  const errors = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 5) {
      errors.push(`Invalid line (need at least 5 fields): ${line.substring(0, 80)}`);
      continue;
    }

    const [name, host, port, username, password] = parts;
    const group = parts[5] || defaultGroup;

    // Use name as server ID (sanitize: lowercase, replace spaces with dashes)
    const id = name.replace(/\s+/g, '-');

    if (config.servers[id] && !overwrite) {
      skipped++;
      continue;
    }

    config.servers[id] = {
      host,
      port: parseInt(port) || 22,
      username: username || 'root',
      password: password || '',
      group,
    };
    imported++;
  }

  saveConfig(config);
  return { imported, skipped, errors, total: Object.keys(config.servers).length };
}

/**
 * Clear all servers from config and close connections.
 */
export function clearAllServers() {
  disconnectAll();
  const config = loadConfig();
  const count = Object.keys(config.servers).length;
  config.servers = {};
  saveConfig(config);
  return { cleared: count };
}

// ═══════════════════════════════════════════════════
// Batch File Operations — 批量 vi / 批量文件编辑核心
// ═══════════════════════════════════════════════════

/**
 * Read the same file from multiple servers in parallel.
 * Returns { serverId: { content, ... } | { error } }.
 */
export async function batchReadFile(serverIds, remotePath, opts = {}) {
  const results = {};
  const promises = serverIds.map(async (id) => {
    try {
      results[id] = await readFile(id, remotePath, opts);
    } catch (err) {
      results[id] = { error: err.message };
    }
  });
  await Promise.all(promises);
  return results;
}

/**
 * Write the same content to the same file on multiple servers in parallel.
 * Returns { serverId: { ok, ... } | { error } }.
 */
export async function batchWriteFile(serverIds, remotePath, content, opts = {}) {
  const results = {};
  const promises = serverIds.map(async (id) => {
    try {
      results[id] = await writeFile(id, remotePath, content, opts);
    } catch (err) {
      results[id] = { error: err.message };
    }
  });
  await Promise.all(promises);
  return results;
}

/**
 * Replace text in the same file on multiple servers in parallel.
 * Returns { serverId: { ok, replacements } | { error } }.
 */
export async function batchReplaceInFile(serverIds, remotePath, oldText, newText, opts = {}) {
  const results = {};
  const promises = serverIds.map(async (id) => {
    try {
      results[id] = await replaceInFile(id, remotePath, oldText, newText, opts);
    } catch (err) {
      results[id] = { error: err.message };
    }
  });
  await Promise.all(promises);
  return results;
}

/**
 * Execute a command on multiple servers and collect structured results.
 * Like execBatch but also resolves group names to server IDs.
 */
export async function batchExecByGroup(groupOrIds, command, opts = {}) {
  const { concurrency = 10 } = opts;
  let serverIds;

  if (typeof groupOrIds === 'string') {
    const groups = listGroups();
    if (groups[groupOrIds]) {
      serverIds = groups[groupOrIds];
    } else {
      serverIds = groupOrIds.split(',').map(s => s.trim());
    }
  } else {
    serverIds = groupOrIds;
  }

  return execBatch(serverIds, command, concurrency);
}

/**
 * Get a project structure overview — optimized for Claude Code context.
 * Returns a tree of the project with key files identified.
 */
export async function getProjectStructure(serverId, projectPath, opts = {}) {
  const { maxDepth = 4, ignorePatterns = ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'] } = opts;

  const ignoreArgs = ignorePatterns.map(p => `-not -path '*/${p}/*'`).join(' ');
  const cmd = `find ${JSON.stringify(projectPath)} -maxdepth ${maxDepth} ${ignoreArgs} -printf '%y %s %p\\n' 2>/dev/null | head -500`;
  const r = await execCommand(serverId, cmd, 15000);

  const entries = [];
  let totalFiles = 0, totalDirs = 0, totalSize = 0;

  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const match = line.match(/^(\S)\s+(\d+)\s+(.+)$/);
    if (match) {
      const [, type, size, path] = match;
      const relPath = path.replace(projectPath, '').replace(/^\//, '');
      if (!relPath) continue;
      const isDir = type === 'd';
      if (isDir) totalDirs++; else totalFiles++;
      totalSize += parseInt(size);
      entries.push({
        type: isDir ? 'dir' : 'file',
        path: relPath,
        size: parseInt(size),
        depth: relPath.split('/').length,
      });
    }
  }

  // Identify key files
  const keyFiles = entries
    .filter(e => e.type === 'file')
    .filter(e => /^(README|CLAUDE|Makefile|Dockerfile|package\.json|requirements\.txt|Cargo\.toml|go\.mod|pyproject\.toml|\.env\.example|docker-compose|tsconfig|vite\.config)/i.test(e.path.split('/').pop()))
    .map(e => e.path);

  return {
    root: projectPath,
    totalFiles, totalDirs,
    totalSizeKB: Math.round(totalSize / 1024),
    keyFiles,
    tree: entries,
  };
}

// ═══════════════════════════════════════════════════
// Token-Efficient File Operations (减少 token 消耗)
// ═══════════════════════════════════════════════════

/**
 * Edit a specific text block in a remote file without rewriting the whole file.
 * Reads → finds block → replaces → writes back. 80-90% fewer tokens than full rewrite.
 */
export async function editBlock(serverId, remotePath, oldBlock, newBlock, opts = {}) {
  const { backup = true } = opts;
  const { content } = await readFile(serverId, remotePath);

  if (!content.includes(oldBlock)) {
    throw new Error(`Block not found in ${remotePath}. First 80 chars: "${oldBlock.substring(0, 80)}..."`);
  }

  const count = content.split(oldBlock).length - 1;
  if (count > 1) {
    throw new Error(`Found ${count} matches. Provide a more specific block.`);
  }

  const newContent = content.replace(oldBlock, newBlock);
  await writeFile(serverId, remotePath, newContent, { backup, createDirs: false });
  return { ok: true, path: remotePath, linesChanged: newBlock.split('\n').length };
}

/**
 * Search for a pattern in files on a remote server. Returns matches with context.
 * More token-efficient than reading entire files.
 */
export async function searchCode(serverId, searchPath, pattern, opts = {}) {
  const { fileType, context = 2, maxResults = 30, caseSensitive = true } = opts;
  const flags = caseSensitive ? '' : '-i';
  const typeFlag = fileType ? `--include=${JSON.stringify(fileType)}` : '';

  const cmd = `grep -rn ${flags} -C ${context} ${typeFlag} ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -${maxResults * (1 + context * 2)}`;
  const r = await execCommand(serverId, cmd, 30000);

  const matches = [];
  let currentMatch = null;

  for (const line of r.stdout.split('\n').filter(Boolean)) {
    if (line === '--') {
      if (currentMatch) matches.push(currentMatch);
      currentMatch = null;
      continue;
    }
    const m = line.match(/^(.+?):(\d+)[:-](.*)$/);
    if (m) {
      if (!currentMatch) currentMatch = { file: m[1], line: parseInt(m[2]), context: [] };
      currentMatch.context.push({ line: parseInt(m[2]), text: m[3] });
    }
  }
  if (currentMatch) matches.push(currentMatch);

  return { pattern, matches, count: matches.length };
}

/**
 * Compare the same file across multiple servers. Returns diffs for config drift detection.
 */
export async function diffFileAcrossServers(serverIds, remotePath) {
  const contents = await batchReadFile(serverIds, remotePath);
  const results = { path: remotePath, servers: {}, identical: true, diffs: [] };

  let reference = null;
  let refServer = null;

  for (const [id, r] of Object.entries(contents)) {
    if (r.error) {
      results.servers[id] = { status: 'error', error: r.error };
      results.identical = false;
      continue;
    }
    results.servers[id] = { status: 'ok', lines: r.content.split('\n').length, size: r.content.length };

    if (reference === null) {
      reference = r.content;
      refServer = id;
    } else if (r.content !== reference) {
      results.identical = false;
      // Find differing lines
      const refLines = reference.split('\n');
      const curLines = r.content.split('\n');
      const diffLines = [];
      const maxLen = Math.max(refLines.length, curLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (refLines[i] !== curLines[i]) {
          diffLines.push({
            line: i + 1,
            reference: refLines[i] || '(missing)',
            current: curLines[i] || '(missing)',
          });
        }
      }
      results.diffs.push({ server: id, vs: refServer, differences: diffLines.slice(0, 20) });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════
// System Monitoring (系统监控工具)
// ═══════════════════════════════════════════════════

/**
 * Quick health check: CPU, memory, disk, load in one call.
 */
export async function healthCheck(serverId) {
  const cmd = `echo "___cpu___"; top -bn1 | grep 'Cpu(s)' | awk '{printf "%.1f", $2+$4}'; echo
echo "___mem___"; free -m | awk '/Mem:/{printf "%d/%dMB (%.1f%%)", $3, $2, $3/$2*100}'
echo "___disk___"; df -h / | awk 'NR==2{printf "%s/%s (%s)", $3, $2, $5}'
echo "___load___"; cat /proc/loadavg | cut -d' ' -f1-3
echo "___uptime___"; uptime -p 2>/dev/null || uptime`;
  const r = await execCommand(serverId, cmd, 10000);

  const info = {};
  const sections = r.stdout.split(/___(\w+)___/).filter(Boolean);
  for (let i = 0; i < sections.length - 1; i += 2) {
    info[sections[i]] = sections[i + 1].trim();
  }
  return info;
}

/**
 * Batch health check across multiple servers.
 */
export async function batchHealthCheck(serverIds) {
  const results = {};
  const promises = serverIds.map(async (id) => {
    try {
      results[id] = await healthCheck(id);
    } catch (err) {
      results[id] = { error: err.message };
    }
  });
  await Promise.all(promises);
  return results;
}

/**
 * List processes on a server, optionally filtered.
 */
export async function processList(serverId, opts = {}) {
  const { filter, sortBy = 'cpu', limit = 20 } = opts;
  let cmd;
  if (sortBy === 'mem') {
    cmd = `ps aux --sort=-%mem | head -${limit + 1}`;
  } else {
    cmd = `ps aux --sort=-%cpu | head -${limit + 1}`;
  }
  if (filter) {
    cmd = `ps aux | head -1; ps aux | grep -i ${JSON.stringify(filter)} | grep -v grep | head -${limit}`;
  }
  const r = await execCommand(serverId, cmd, 10000);
  return { processes: r.stdout, filter: filter || null, sortBy };
}

/**
 * Docker container status.
 */
export async function dockerStatus(serverId) {
  const cmd = `echo "___containers___"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}' 2>/dev/null || echo "Docker not available"
echo "___images___"
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null | head -20
echo "___stats___"
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null | head -20`;
  const r = await execCommand(serverId, cmd, 15000);

  const info = {};
  const sections = r.stdout.split(/___(\w+)___/).filter(Boolean);
  for (let i = 0; i < sections.length - 1; i += 2) {
    info[sections[i]] = sections[i + 1].trim();
  }
  return info;
}

/**
 * Network information: interfaces, routes, connections.
 */
export async function networkInfo(serverId) {
  const cmd = `echo "___interfaces___"
ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | grep -A1 'inet '
echo "___routes___"
ip route 2>/dev/null | head -10
echo "___connections___"
ss -tunp 2>/dev/null | head -20 || netstat -tunp 2>/dev/null | head -20
echo "___dns___"
cat /etc/resolv.conf 2>/dev/null | grep nameserver`;
  const r = await execCommand(serverId, cmd, 10000);

  const info = {};
  const sections = r.stdout.split(/___(\w+)___/).filter(Boolean);
  for (let i = 0; i < sections.length - 1; i += 2) {
    info[sections[i]] = sections[i + 1].trim();
  }
  return info;
}

// ═══════════════════════════════════════════════════
// Deployment & Sync (部署与同步)
// ═══════════════════════════════════════════════════

/**
 * Upload a local file to multiple servers in parallel via SFTP.
 */
export async function batchUploadFile(serverIds, localPath, remotePath) {
  const results = {};
  const promises = serverIds.map(async (id) => {
    try {
      results[id] = await uploadFile(id, localPath, remotePath);
    } catch (err) {
      results[id] = { error: err.message };
    }
  });
  await Promise.all(promises);
  return results;
}

/**
 * Sync a file between two servers (server-to-server copy via local relay).
 */
export async function syncFileBetweenServers(fromServerId, toServerId, remotePath, opts = {}) {
  const { toPath } = opts;
  const destPath = toPath || remotePath;

  // Read from source
  const { content } = await readFile(fromServerId, remotePath);
  // Write to destination
  await writeFile(toServerId, destPath, content, { backup: true });

  return { ok: true, from: fromServerId, to: toServerId, path: remotePath, destPath, size: content.length };
}

