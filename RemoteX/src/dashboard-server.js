#!/usr/bin/env node
/**
 * RemoteX Dashboard Server
 * 
 * WebSocket + HTTP server that bridges the dashboard UI with the SSH bridge.
 * Provides:
 * - Real-time server status streaming
 * - Canary deployment engine (precheck → canary → wave → verify → rollback)
 * - Claude Code activity event bus
 * - REST API for dashboard
 * 
 * Usage:
 *   node src/dashboard-server.js [--port 7700]
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as bridge from './bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') || '7700');

// ═══════════════════════════════════════════════════
// Event Bus — all dashboard events flow through here
// ═══════════════════════════════════════════════════

class EventBus {
  constructor() {
    this.clients = new Set();
    this.logs = [];
    this.maxLogs = 500;
    this.agentStatuses = {};    // serverId -> { text, color, timestamp }
    this.deployments = [];      // deployment history
    this.activeDeployment = null;
  }

  addClient(ws) {
    this.clients.add(ws);
    // Send initial state
    ws.send(JSON.stringify({
      type: 'init',
      logs: this.logs.slice(-100),
      agentStatuses: this.agentStatuses,
      activeDeployment: this.activeDeployment,
    }));
  }

  removeClient(ws) { this.clients.delete(ws); }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  log(level, source, msg) {
    const entry = {
      ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
      level, source, msg,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    this.broadcast({ type: 'log', entry });
  }

  setAgentStatus(serverId, text, color = '#ff71ce') {
    if (text) {
      this.agentStatuses[serverId] = { text, color, timestamp: Date.now() };
    } else {
      delete this.agentStatuses[serverId];
    }
    this.broadcast({ type: 'agent_status', serverId, status: this.agentStatuses[serverId] || null });
  }

  updateDeployment(deployment) {
    this.activeDeployment = deployment;
    this.broadcast({ type: 'deployment', deployment });
  }
}

const bus = new EventBus();

// ═══════════════════════════════════════════════════
// Server Status Poller
// ═══════════════════════════════════════════════════

let cachedServerData = [];

async function pollServerStatus() {
  try {
    const config = bridge.loadConfig();
    const serverIds = Object.keys(config.servers);
    if (!serverIds.length) return;

    const results = [];
    const batchSize = 10;

    for (let i = 0; i < serverIds.length; i += batchSize) {
      const chunk = serverIds.slice(i, i + batchSize);
      const promises = chunk.map(async (id) => {
        const srv = config.servers[id];
        try {
          const info = await bridge.getServerInfo(id);
          return {
            id, host: srv.host, port: srv.port || 22,
            username: srv.username || 'root',
            group: srv.group || 'default',
            status: 'online',
            cpu: parseFloat(info.cpu_usage) || 0,
            mem: parseFloat(info.mem_percent) || 0,
            disk: parseFloat(info.disk_percent) || 0,
            load: info.load || '0',
            uptime: info.uptime || '?',
            ports: info.listening_ports || '',
            hostname: info.hostname || id,
            os: info.os || '',
            kernel: info.kernel || '',
            ip: info.ip || srv.host,
            memTotal: info.mem_total || '0',
            memUsed: info.mem_used || '0',
            diskTotal: info.disk_total || '0',
            diskUsed: info.disk_used || '0',
            cpuCores: info.cpu_cores || '?',
            dockerRunning: info.docker_running || '0',
          };
        } catch (err) {
          return {
            id, host: srv.host, port: srv.port || 22,
            username: srv.username || 'root',
            group: srv.group || 'default',
            status: 'offline',
            cpu: 0, mem: 0, disk: 0, load: '0', uptime: '?',
            ports: '', error: err.message,
          };
        }
      });
      results.push(...await Promise.all(promises));
    }

    cachedServerData = results;
    bus.broadcast({ type: 'servers', servers: results });
  } catch (err) {
    bus.log('error', 'poller', `Status poll failed: ${err.message}`);
  }
}

// Service discovery for each server
async function getServerServices(serverId) {
  try {
    const r = await bridge.execCommand(serverId,
      "systemctl list-units --type=service --state=active,failed --no-pager --no-legend | awk '{print $1, $3}' | head -30",
      10000
    );
    const services = {};
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [name, sub] = line.split(/\s+/);
      const svcName = name.replace('.service', '');
      // Filter to interesting services only
      const keep = ['nginx', 'apache2', 'httpd', 'mysql', 'mysqld', 'mariadb',
        'postgresql', 'redis', 'redis-server', 'docker', 'sshd', 'named', 'bind9',
        'prometheus', 'grafana-server', 'node_exporter', 'haproxy', 'keepalived',
        'smsc', 'elasticsearch', 'kibana', 'logstash', 'mongod', 'rabbitmq-server',
        'php-fpm', 'supervisord', 'crond', 'cron', 'firewalld', 'ufw'];
      if (keep.includes(svcName)) {
        services[svcName] = sub === 'running' ? 'active' : 'failed';
      }
    }
    return services;
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════
// Canary Deployment Engine
// ═══════════════════════════════════════════════════

class CanaryDeployer {
  constructor(eventBus) {
    this.bus = eventBus;
    this.aborted = false;
  }

  async deploy(opts) {
    const { command, rollbackCommand, canaryServerId, serverIds, waveSizes, preCheck, postCheck } = opts;

    this.aborted = false;
    const deployment = {
      id: Date.now().toString(36),
      command, rollbackCommand,
      canaryServerId,
      serverIds,
      phase: 'precheck',
      progress: 0,
      results: [],
      startedAt: Date.now(),
      status: 'running',
    };

    this.bus.updateDeployment(deployment);
    this.bus.log('info', 'canary', `Starting canary deployment: ${command}`);
    this.bus.log('info', 'canary', `Canary: ${canaryServerId} | Fleet: ${serverIds.length} servers`);

    try {
      // ── Phase 1: Pre-Check ──
      deployment.phase = 'precheck';
      this.bus.updateDeployment(deployment);
      this.bus.log('info', 'precheck', 'Running pre-flight checks...');

      const preCheckCmd = preCheck || 'echo "ready"';
      const allIds = [canaryServerId, ...serverIds.filter(id => id !== canaryServerId)];

      for (const id of allIds) {
        if (this.aborted) throw new Error('Aborted by user');
        this.bus.setAgentStatus(id, '🔍 Pre-checking');
        try {
          const r = await bridge.execCommand(id, preCheckCmd, 15000);
          deployment.results.push({ phase: 'precheck', server: id, status: r.code === 0 ? 'ok' : 'fail', output: r.stdout || r.stderr });
          if (r.code !== 0) {
            this.bus.log('error', 'precheck', `Pre-check FAILED on ${id}: ${r.stderr}`);
            throw new Error(`Pre-check failed on ${id}`);
          }
        } catch (err) {
          if (err.message.includes('Aborted')) throw err;
          deployment.results.push({ phase: 'precheck', server: id, status: 'fail', output: err.message });
          this.bus.log('error', 'precheck', `Cannot reach ${id}: ${err.message}`);
          throw new Error(`Pre-check failed: ${id} unreachable`);
        } finally {
          this.bus.setAgentStatus(id, null);
        }
      }

      deployment.progress = 20;
      this.bus.updateDeployment(deployment);
      this.bus.log('ok', 'precheck', `Pre-check passed on ${allIds.length} servers`);

      // ── Phase 2: Canary ──
      deployment.phase = 'canary';
      this.bus.updateDeployment(deployment);
      this.bus.log('info', 'canary', `Deploying to canary: ${canaryServerId}`);
      this.bus.setAgentStatus(canaryServerId, '🐤 Canary deploying', '#ff9f43');

      const canaryResult = await bridge.execCommand(canaryServerId, command, 60000);
      deployment.results.push({ phase: 'canary', server: canaryServerId, status: canaryResult.code === 0 ? 'ok' : 'fail', output: canaryResult.stdout || canaryResult.stderr });
      this.bus.setAgentStatus(canaryServerId, null);

      if (canaryResult.code !== 0) {
        this.bus.log('error', 'canary', `Canary FAILED on ${canaryServerId}: ${canaryResult.stderr}`);
        throw new Error(`Canary failed on ${canaryServerId}`);
      }

      // Canary verification
      this.bus.log('info', 'canary', 'Verifying canary...');
      this.bus.setAgentStatus(canaryServerId, '🔍 Verifying canary');
      const verifyCmd = postCheck || 'echo "ok"';
      const verifyResult = await bridge.execCommand(canaryServerId, verifyCmd, 15000);
      this.bus.setAgentStatus(canaryServerId, null);

      if (verifyResult.code !== 0) {
        this.bus.log('error', 'canary', `Canary verification FAILED — rolling back`);
        if (rollbackCommand) {
          await bridge.execCommand(canaryServerId, rollbackCommand, 30000);
          this.bus.log('warn', 'rollback', `Rolled back canary: ${canaryServerId}`);
        }
        throw new Error('Canary verification failed');
      }

      deployment.progress = 40;
      this.bus.updateDeployment(deployment);
      this.bus.log('ok', 'canary', `Canary passed on ${canaryServerId}`);

      // ── Phase 3: Wave Deployment ──
      const remaining = serverIds.filter(id => id !== canaryServerId);
      const waveSize = waveSizes || Math.max(1, Math.ceil(remaining.length / 3));
      const waves = [];
      for (let i = 0; i < remaining.length; i += waveSize) {
        waves.push(remaining.slice(i, i + waveSize));
      }

      for (let wi = 0; wi < waves.length; wi++) {
        if (this.aborted) throw new Error('Aborted by user');

        const wave = waves[wi];
        deployment.phase = `wave${wi + 1}`;
        this.bus.updateDeployment(deployment);
        this.bus.log('info', `wave${wi + 1}`, `Deploying wave ${wi + 1}/${waves.length}: ${wave.join(', ')}`);

        // Set agent status on all wave servers
        for (const id of wave) {
          this.bus.setAgentStatus(id, `🌊 Wave ${wi + 1}`, '#b967ff');
        }

        // Execute in parallel within wave
        const waveResults = await bridge.execBatch(wave, command, wave.length);

        let waveFailed = false;
        for (const [id, r] of Object.entries(waveResults)) {
          this.bus.setAgentStatus(id, null);
          const ok = r.code === 0;
          deployment.results.push({ phase: `wave${wi + 1}`, server: id, status: ok ? 'ok' : 'fail', output: r.stdout || r.stderr });
          if (!ok) {
            this.bus.log('error', `wave${wi + 1}`, `FAILED on ${id}: ${r.stderr}`);
            waveFailed = true;
          }
        }

        if (waveFailed) {
          this.bus.log('error', `wave${wi + 1}`, 'Wave had failures — initiating rollback');
          // Rollback this wave + canary
          if (rollbackCommand) {
            const rollbackTargets = [canaryServerId, ...waves.slice(0, wi + 1).flat()];
            this.bus.log('warn', 'rollback', `Rolling back ${rollbackTargets.length} servers...`);
            for (const id of rollbackTargets) {
              this.bus.setAgentStatus(id, '⏪ Rolling back', '#ff4757');
            }
            await bridge.execBatch(rollbackTargets, rollbackCommand, 10);
            for (const id of rollbackTargets) {
              this.bus.setAgentStatus(id, null);
            }
            this.bus.log('warn', 'rollback', 'Rollback complete');
          }
          throw new Error(`Wave ${wi + 1} failed`);
        }

        deployment.progress = 40 + ((wi + 1) / waves.length) * 40;
        this.bus.updateDeployment(deployment);
        this.bus.log('ok', `wave${wi + 1}`, `Wave ${wi + 1} complete: ${wave.length} servers OK`);

        // Brief pause between waves
        if (wi < waves.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // ── Phase 4: Post-Verify ──
      deployment.phase = 'verify';
      deployment.progress = 90;
      this.bus.updateDeployment(deployment);
      this.bus.log('info', 'verify', 'Running post-deployment verification...');

      if (postCheck) {
        const verifyResults = await bridge.execBatch(allIds, postCheck, 10);
        let allOk = true;
        for (const [id, r] of Object.entries(verifyResults)) {
          if (r.code !== 0) {
            this.bus.log('error', 'verify', `Post-check failed on ${id}`);
            allOk = false;
          }
        }
        if (!allOk) {
          this.bus.log('warn', 'verify', 'Some post-checks failed — review manually');
        }
      }

      // ── Done ──
      deployment.phase = 'done';
      deployment.progress = 100;
      deployment.status = 'success';
      deployment.completedAt = Date.now();
      this.bus.updateDeployment(deployment);
      this.bus.log('ok', 'canary', `Deployment complete — ${allIds.length} servers updated successfully`);

    } catch (err) {
      deployment.status = 'failed';
      deployment.error = err.message;
      deployment.completedAt = Date.now();
      this.bus.updateDeployment(deployment);
      this.bus.log('error', 'deploy', `Deployment failed: ${err.message}`);
    }

    return deployment;
  }

  abort() {
    this.aborted = true;
    this.bus.log('warn', 'deploy', 'Deployment abort requested');
  }
}

const deployer = new CanaryDeployer(bus);

// ═══════════════════════════════════════════════════
// HTTP + WebSocket Server
// ═══════════════════════════════════════════════════

const httpServer = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ── REST API ──

    if (path === '/api/servers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servers: cachedServerData }));
      return;
    }

    if (path === '/api/servers/refresh' && req.method === 'POST') {
      pollServerStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path.startsWith('/api/server/') && req.method === 'GET') {
      const serverId = path.split('/')[3];
      const info = await bridge.getServerInfo(serverId);
      const services = await getServerServices(serverId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...info, services }));
      return;
    }

    if (path === '/api/exec' && req.method === 'POST') {
      const body = await readBody(req);
      const { server, command, timeout } = JSON.parse(body);
      bus.log('info', 'exec', `${server}: ${command}`);
      bus.setAgentStatus(server, '⚡ Executing');
      const r = await bridge.execCommand(server, command, timeout || 30000);
      bus.setAgentStatus(server, null);
      bus.log(r.code === 0 ? 'ok' : 'error', server, `Exit ${r.code}: ${(r.stdout || r.stderr).substring(0, 100)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }

    if (path === '/api/exec-batch' && req.method === 'POST') {
      const body = await readBody(req);
      const { servers: srvList, group, command } = JSON.parse(body);
      let ids = srvList || [];
      if (group) {
        const groups = bridge.listGroups();
        ids = groups[group] || [];
      }
      bus.log('info', 'batch', `Executing on ${ids.length} servers: ${command}`);
      for (const id of ids) bus.setAgentStatus(id, '⚡ Batch exec');
      const results = await bridge.execBatch(ids, command);
      for (const id of ids) bus.setAgentStatus(id, null);
      const ok = Object.values(results).filter(r => r.code === 0).length;
      bus.log('ok', 'batch', `Batch complete: ${ok}/${ids.length} OK`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
      return;
    }

    if (path === '/api/service' && req.method === 'POST') {
      const body = await readBody(req);
      const { server, service, action } = JSON.parse(body);
      bus.log('info', 'service', `${server}: ${action} ${service}`);
      bus.setAgentStatus(server, `🔧 ${action} ${service}`);
      const r = await bridge.manageService(server, service, action);
      bus.setAgentStatus(server, null);
      bus.log(r.code === 0 ? 'ok' : 'error', server, `${service} ${action}: exit ${r.code}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }

    if (path === '/api/deploy' && req.method === 'POST') {
      const body = await readBody(req);
      const opts = JSON.parse(body);
      // Don't await — run in background
      deployer.deploy(opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Deployment started' }));
      return;
    }

    if (path === '/api/deploy/abort' && req.method === 'POST') {
      deployer.abort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/api/groups' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bridge.listGroups()));
      return;
    }

    if (path === '/api/logs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs: bus.logs.slice(-100) }));
      return;
    }

    // ── Server Management API ──

    if (path === '/api/server/add' && req.method === 'POST') {
      const body = await readBody(req);
      const { id, host, port, username, password, group } = JSON.parse(body);
      if (!id || !host) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id and host are required' }));
        return;
      }
      const config = bridge.loadConfig();
      config.servers[id] = { host, port: port || 22, username: username || 'root', password: password || '', group: group || 'default' };
      bridge.saveConfig(config);
      bus.log('info', 'config', `Server added: ${id} (${host})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/api/server/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const { id } = JSON.parse(body);
      const config = bridge.loadConfig();
      if (config.servers[id]) {
        delete config.servers[id];
        bridge.saveConfig(config);
        bus.log('info', 'config', `Server removed: ${id}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/api/servers/import' && req.method === 'POST') {
      const body = await readBody(req);
      const { csv } = JSON.parse(body);
      const config = bridge.loadConfig();
      let count = 0;
      for (const line of csv.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(',');
        if (parts.length < 2) continue;
        const [id, host, port, username, password, group] = parts.map(s => s.trim());
        config.servers[id] = {
          host,
          port: parseInt(port) || 22,
          username: username || 'root',
          password: password || '',
          group: group || 'default'
        };
        count++;
      }
      bridge.saveConfig(config);
      bus.log('info', 'config', `Imported ${count} servers from CSV`);
      // Trigger refresh
      pollServerStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count }));
      return;
    }

    if (path === '/api/servers/import-file' && req.method === 'POST') {
      // Import from local servers.txt file
      try {
        const filePath = join(__dirname, '..', 'servers.txt');
        const csv = readFileSync(filePath, 'utf-8');
        const config = bridge.loadConfig();
        let count = 0;
        for (const line of csv.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split(',');
          if (parts.length < 2) continue;
          const [id, host, port, username, password, group] = parts.map(s => s.trim());
          config.servers[id] = {
            host,
            port: parseInt(port) || 22,
            username: username || 'root',
            password: password || '',
            group: group || 'default'
          };
          count++;
        }
        bridge.saveConfig(config);
        bus.log('ok', 'config', `Imported ${count} servers from servers.txt`);
        pollServerStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === '/api/servers/clear' && req.method === 'POST') {
      const config = bridge.loadConfig();
      const count = Object.keys(config.servers).length;
      config.servers = {};
      bridge.saveConfig(config);
      cachedServerData = [];
      bus.broadcast({ type: 'servers', servers: [] });
      bus.log('warn', 'config', `Cleared all ${count} servers`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count }));
      return;
    }

    if (path === '/api/servers/list-config' && req.method === 'GET') {
      const config = bridge.loadConfig();
      const list = Object.entries(config.servers).map(([id, s]) => ({
        id, host: s.host, port: s.port || 22, username: s.username || 'root', group: s.group || 'default'
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servers: list, total: list.length }));
      return;
    }

    // ── Claude Code webhook (for hooks integration) ──
    if (path === '/api/claude-event' && req.method === 'POST') {
      const body = await readBody(req);
      const event = JSON.parse(body);
      bus.log('claude', 'claude', event.message || 'Claude Code event');
      if (event.server) bus.setAgentStatus(event.server, event.status || '◆ Claude active');
      if (event.clearServer) bus.setAgentStatus(event.clearServer, null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Serve Dashboard UI ──
    if (path === '/' || path === '/index.html') {
      try {
        const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      } catch { /* fall through to 404 */ }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// WebSocket
const wss = new WebSocketServer({ server: httpServer });

// ═══════════════════════════════════════════════════
// Shell Session Manager
// ═══════════════════════════════════════════════════

const shellSessions = new Map(); // sessionId -> { shell, serverId, ws }

function cleanupShellSessions(ws) {
  for (const [sessionId, session] of shellSessions) {
    if (session.ws === ws) {
      try { session.shell.close(); } catch {}
      shellSessions.delete(sessionId);
      bus.log('info', 'shell', `Session closed: ${session.serverId} (${sessionId})`);
    }
  }
}

wss.on('connection', (ws) => {
  bus.addClient(ws);
  bus.log('info', 'ws', 'Dashboard client connected');

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'exec') {
        bus.setAgentStatus(msg.server, '⚡ Executing');
        const r = await bridge.execCommand(msg.server, msg.command, msg.timeout || 30000);
        bus.setAgentStatus(msg.server, null);
        ws.send(JSON.stringify({ type: 'exec_result', requestId: msg.requestId, server: msg.server, result: r }));
        bus.log(r.code === 0 ? 'ok' : 'error', msg.server, `${msg.command.substring(0, 60)} → exit ${r.code}`);
      }

      if (msg.type === 'service') {
        bus.setAgentStatus(msg.server, `🔧 ${msg.action} ${msg.service}`);
        const r = await bridge.manageService(msg.server, msg.service, msg.action);
        bus.setAgentStatus(msg.server, null);
        ws.send(JSON.stringify({ type: 'service_result', requestId: msg.requestId, result: r }));
      }

      if (msg.type === 'refresh') {
        pollServerStatus();
      }

      // ── Interactive Shell ──
      if (msg.type === 'shell_open') {
        const sessionId = msg.sessionId || Date.now().toString(36);
        try {
          const shell = await bridge.openShell(msg.server, { cols: msg.cols || 120, rows: msg.rows || 30 });
          shellSessions.set(sessionId, { shell, serverId: msg.server, ws });

          shell.stream.on('data', (data) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'shell_data', sessionId, data: data.toString('base64') }));
            }
          });

          shell.stream.on('close', () => {
            shellSessions.delete(sessionId);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'shell_closed', sessionId }));
            }
          });

          shell.stream.stderr.on('data', (data) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'shell_data', sessionId, data: data.toString('base64') }));
            }
          });

          ws.send(JSON.stringify({ type: 'shell_opened', sessionId, server: msg.server }));
          bus.log('info', 'shell', `Shell opened: ${msg.server} (${sessionId})`);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'shell_error', sessionId, error: err.message }));
          bus.log('error', 'shell', `Shell failed for ${msg.server}: ${err.message}`);
        }
      }

      if (msg.type === 'shell_input') {
        const session = shellSessions.get(msg.sessionId);
        if (session) {
          const buf = Buffer.from(msg.data, 'base64');
          session.shell.stream.write(buf);
        }
      }

      if (msg.type === 'shell_resize') {
        const session = shellSessions.get(msg.sessionId);
        if (session) {
          session.shell.resize(msg.cols, msg.rows);
        }
      }

      if (msg.type === 'shell_close') {
        const session = shellSessions.get(msg.sessionId);
        if (session) {
          session.shell.close();
          shellSessions.delete(msg.sessionId);
          bus.log('info', 'shell', `Shell closed: ${session.serverId} (${msg.sessionId})`);
        }
      }

    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    cleanupShellSessions(ws);
    bus.removeClient(ws);
  });
});

// ═══════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════

httpServer.listen(PORT, () => {
  console.log(`
  ◈ SOVEREIGN Dashboard Server
  ─────────────────────────────
  HTTP API:    http://localhost:${PORT}/api/
  WebSocket:   ws://localhost:${PORT}
  Dashboard:   http://localhost:${PORT}/
  
  Claude Code hook:
    curl -X POST http://localhost:${PORT}/api/claude-event \\
      -H "Content-Type: application/json" \\
      -d '{"message": "Task started", "server": "prod-01", "status": "⚡ Working"}'
  `);

  bus.log('info', 'system', `SOVEREIGN Dashboard Server started on port ${PORT}`);

  // Initial poll
  pollServerStatus();

  // Poll every 30 seconds
  setInterval(pollServerStatus, 30000);
});
