#!/usr/bin/env node
/**
 * remotex CLI
 * 
 * Standalone CLI for Claude Code to manage SSH servers.
 * Works without MCP — Claude Code can call this directly via bash.
 * 
 * Usage:
 *   remotex list                              # List all servers
 *   remotex info <server>                     # Server system info
 *   remotex exec <server> <command>           # Execute command
 *   remotex batch <group|server,server> <cmd> # Batch execute
 *   remotex add <id> <host> [options]         # Add server
 *   remotex remove <id>                       # Remove server
 *   remotex groups                            # List groups
 *   remotex upload <server> <local> <remote>  # Upload file
 *   remotex download <server> <remote> <local># Download file
 *   remotex tail <server> <logpath> [lines]   # Tail log
 *   remotex service <server> <name> <action>  # Manage service
 *   remotex ports <server>                    # List listening ports
 *   remotex status                            # Quick status of all servers
 *   remotex import <file> [options]           # Import servers from ip.txt
 *   remotex clear-all                         # Remove all servers
 *   remotex batch-cat <group|s,s> <path>      # Read file from multiple servers
 *   remotex batch-write <group|s,s> <path>    # Write file to multiple servers (stdin)
 *   remotex batch-replace <group|s,s> <path> <old> <new>  # Replace in file on multiple servers
 */

import * as bridge from '../src/bridge.js';

const args = process.argv.slice(2);
const cmd = args[0];

function resolveTarget(target) {
  const groups = bridge.listGroups();
  if (groups[target]) return groups[target];
  return target.split(',').map(s => s.trim());
}

async function main() {
  try {
    switch (cmd) {
      case 'list':
      case 'ls': {
        const checkAlive = args.includes('--check') || args.includes('-c');
        const servers = await bridge.listServers(checkAlive);
        if (!servers.length) {
          console.log('No servers configured. Use "remotex add <id> <host>" to add one.');
          break;
        }
        console.log(`\n  Servers (${servers.length}):\n`);
        for (const s of servers) {
          const status = s.status === 'online' ? '●' : s.status === 'offline' ? '○' : '?';
          console.log(`  ${status} ${s.id.padEnd(20)} ${s.host.padEnd(18)} :${s.port}  @${s.username}  [${s.group}]`);
        }
        console.log();
        break;
      }

      case 'info': {
        const server = args[1];
        if (!server) { console.error('Usage: remotex info <server>'); process.exit(1); }
        const info = await bridge.getServerInfo(server);
        console.log(`\n  Server: ${server}\n`);
        console.log(`  Hostname:    ${info.hostname || '?'}`);
        console.log(`  OS:          ${info.os || '?'}`);
        console.log(`  Kernel:      ${info.kernel || '?'}`);
        console.log(`  IP:          ${info.ip || '?'}`);
        console.log(`  Uptime:      ${info.uptime || '?'}`);
        console.log(`  CPU:         ${info.cpu_cores || '?'} cores, ${info.cpu_usage || '?'}% usage`);
        console.log(`  Memory:      ${info.mem_used || '?'}/${info.mem_total || '?'} MB (${info.mem_percent || '?'}%)`);
        console.log(`  Disk:        ${info.disk_used || '?'}/${info.disk_total || '?'} (${info.disk_percent || '?'})`);
        console.log(`  Load:        ${info.load || '?'}`);
        console.log(`  Docker:      ${info.docker_running || '0'} containers`);
        console.log(`  Ports:       ${info.listening_ports || 'none'}`);
        console.log();
        break;
      }

      case 'exec':
      case 'run': {
        const server = args[1];
        const command = args.slice(2).join(' ');
        if (!server || !command) { console.error('Usage: remotex exec <server> <command>'); process.exit(1); }
        const r = await bridge.execCommand(server, command);
        if (r.stdout) process.stdout.write(r.stdout + '\n');
        if (r.stderr) process.stderr.write(r.stderr + '\n');
        process.exit(r.code);
      }

      case 'batch': {
        const target = args[1];
        const command = args.slice(2).join(' ');
        if (!target || !command) { console.error('Usage: remotex batch <group|s1,s2,...> <command>'); process.exit(1); }

        let serverIds;
        const groups = bridge.listGroups();
        if (groups[target]) {
          serverIds = groups[target];
        } else {
          serverIds = target.split(',');
        }

        console.log(`\n  Executing on ${serverIds.length} servers: ${command}\n`);
        const results = await bridge.execBatch(serverIds, command);

        for (const [id, r] of Object.entries(results)) {
          const icon = r.code === 0 ? '✓' : '✗';
          const preview = (r.stdout || r.stderr || '').split('\n')[0].substring(0, 80);
          console.log(`  ${icon} ${id.padEnd(20)} [exit ${r.code}] ${preview}`);
        }
        console.log();
        break;
      }

      case 'add': {
        const id = args[1], host = args[2];
        if (!id || !host) { console.error('Usage: remotex add <id> <host> [--user root] [--port 22] [--key ~/.ssh/id_rsa] [--group prod]'); process.exit(1); }
        const opts = {};
        for (let i = 3; i < args.length; i += 2) {
          if (args[i] === '--user') opts.username = args[i + 1];
          if (args[i] === '--port') opts.port = parseInt(args[i + 1]);
          if (args[i] === '--key') opts.privateKey = args[i + 1];
          if (args[i] === '--pass') opts.password = args[i + 1];
          if (args[i] === '--group') opts.group = args[i + 1];
        }
        bridge.addServer(id, host, opts);
        console.log(`  ✓ Added server: ${id} (${host})`);
        break;
      }

      case 'remove':
      case 'rm': {
        const id = args[1];
        if (!id) { console.error('Usage: remotex remove <id>'); process.exit(1); }
        bridge.removeServer(id);
        console.log(`  ✓ Removed server: ${id}`);
        break;
      }

      case 'groups': {
        const groups = bridge.listGroups();
        console.log('\n  Groups:\n');
        for (const [name, ids] of Object.entries(groups)) {
          console.log(`  ${name}: ${ids.join(', ')}`);
        }
        console.log();
        break;
      }

      case 'upload': {
        const [, server, local, remote] = args;
        if (!server || !local || !remote) { console.error('Usage: remotex upload <server> <local> <remote>'); process.exit(1); }
        await bridge.uploadFile(server, local, remote);
        console.log(`  ✓ Uploaded ${local} → ${server}:${remote}`);
        break;
      }

      case 'download': {
        const [, server, remote, local] = args;
        if (!server || !remote || !local) { console.error('Usage: remotex download <server> <remote> <local>'); process.exit(1); }
        await bridge.downloadFile(server, remote, local);
        console.log(`  ✓ Downloaded ${server}:${remote} → ${local}`);
        break;
      }

      case 'tail': {
        const server = args[1], logPath = args[2], lines = parseInt(args[3]) || 50;
        if (!server || !logPath) { console.error('Usage: remotex tail <server> <logpath> [lines]'); process.exit(1); }
        const r = await bridge.tailLog(server, logPath, lines);
        console.log(r.stdout);
        break;
      }

      case 'service':
      case 'svc': {
        const [, server, name, action] = args;
        if (!server || !name || !action) { console.error('Usage: remotex service <server> <name> <start|stop|restart|status>'); process.exit(1); }
        const r = await bridge.manageService(server, name, action);
        if (r.stdout) console.log(r.stdout);
        if (r.stderr) console.error(r.stderr);
        break;
      }

      case 'ports': {
        const server = args[1];
        if (!server) { console.error('Usage: remotex ports <server>'); process.exit(1); }
        const ports = await bridge.getListeningPorts(server);
        console.log(`\n  Listening ports on ${server}:\n`);
        for (const p of ports) {
          console.log(`  :${String(p.port).padEnd(6)} ${p.process.padEnd(20)} PID ${p.pid}`);
        }
        console.log();
        break;
      }

      // ── Remote File Operations ──

      case 'cat':
      case 'read': {
        const server = args[1], path = args[2];
        if (!server || !path) { console.error('Usage: remotex cat <server> <path> [startLine] [endLine]'); process.exit(1); }
        const startLine = args[3] ? parseInt(args[3]) : undefined;
        const endLine = args[4] ? parseInt(args[4]) : undefined;
        const r = await bridge.readFile(server, path, { startLine, endLine });
        if (r.warning) console.error(`  ⚠ ${r.warning}`);
        console.log(r.content);
        break;
      }

      case 'write': {
        const server = args[1], path = args[2];
        if (!server || !path) { console.error('Usage: remotex write <server> <path> (reads stdin)'); process.exit(1); }
        // Read content from stdin
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const content = Buffer.concat(chunks).toString('utf-8');
        const noBackup = args.includes('--no-backup');
        const r = await bridge.writeFile(server, path, content, { backup: !noBackup });
        console.log(`  ✓ Written ${path} (${content.length} bytes, backup: ${!noBackup})`);
        break;
      }

      case 'replace': {
        const server = args[1], path = args[2], old = args[3], nw = args[4];
        if (!server || !path || !old || nw === undefined) { console.error('Usage: remotex replace <server> <path> <old_text> <new_text> [--all]'); process.exit(1); }
        const all = args.includes('--all');
        const r = await bridge.replaceInFile(server, path, old, nw, { all });
        console.log(`  ✓ Replaced ${r.replacements} occurrence(s) in ${path}`);
        break;
      }

      case 'dir':
      case 'lsdir': {
        const server = args[1], path = args[2] || '/';
        if (!server) { console.error('Usage: remotex dir <server> [path] [--recursive] [--hidden]'); process.exit(1); }
        const recursive = args.includes('--recursive') || args.includes('-r');
        const showHidden = args.includes('--hidden') || args.includes('-a');
        const r = await bridge.listDir(server, path, { recursive, showHidden });
        console.log(`\n  ${path} (${r.entries.length} entries):\n`);
        for (const e of r.entries) {
          const icon = e.type === 'directory' ? '📁' : e.type === 'symlink' ? '🔗' : '  ';
          const size = e.type === 'file' ? `${e.size}` : '';
          const name = recursive ? e.path : e.name;
          console.log(`  ${icon} ${(name || '').padEnd(40)} ${size.padStart(10)} ${e.permissions || ''} ${e.owner || ''}`);
        }
        console.log();
        break;
      }

      case 'find':
      case 'grep': {
        const server = args[1], searchPath = args[2];
        if (!server || !searchPath) { console.error('Usage: remotex find <server> <path> --name "*.py" OR --content "def main"'); process.exit(1); }
        const nameIdx = args.indexOf('--name');
        const contentIdx = args.indexOf('--content');
        const typeIdx = args.indexOf('--type');
        const opts = {};
        if (nameIdx > 0) opts.namePattern = args[nameIdx + 1];
        if (contentIdx > 0) opts.contentPattern = args[contentIdx + 1];
        if (typeIdx > 0) opts.fileType = args[typeIdx + 1];
        if (!opts.namePattern && !opts.contentPattern) { console.error('Specify --name or --content'); process.exit(1); }

        const r = await bridge.findFiles(server, searchPath, opts);
        if (r.type === 'name') {
          console.log(`\n  Found ${r.count} files matching "${r.query}":\n`);
          for (const f of r.files) console.log(`  ${f}`);
        } else {
          console.log(`\n  Found "${r.query}" in ${r.fileCount} files:\n`);
          for (const m of r.matches) {
            console.log(`  ${m.file}:${m.line}  ${m.content}`);
          }
        }
        console.log();
        break;
      }

      case 'stat': {
        const server = args[1], path = args[2];
        if (!server || !path) { console.error('Usage: remotex stat <server> <path>'); process.exit(1); }
        const r = await bridge.statFile(server, path);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'mkdir': {
        const server = args[1], path = args[2];
        if (!server || !path) { console.error('Usage: remotex mkdir <server> <path>'); process.exit(1); }
        await bridge.mkDir(server, path);
        console.log(`  ✓ Created ${path}`);
        break;
      }

      case 'rm': {
        const server = args[1], path = args[2];
        if (!server || !path) { console.error('Usage: remotex rm <server> <path> [-r]'); process.exit(1); }
        const recursive = args.includes('-r') || args.includes('--recursive');
        await bridge.deleteFile(server, path, { recursive });
        console.log(`  ✓ Deleted ${path}`);
        break;
      }

      case 'mv': {
        const server = args[1], from = args[2], to = args[3];
        if (!server || !from || !to) { console.error('Usage: remotex mv <server> <from> <to>'); process.exit(1); }
        await bridge.moveFile(server, from, to);
        console.log(`  ✓ Moved ${from} → ${to}`);
        break;
      }

      case 'cp': {
        const server = args[1], from = args[2], to = args[3];
        if (!server || !from || !to) { console.error('Usage: remotex cp <server> <from> <to> [-r]'); process.exit(1); }
        const recursive = args.includes('-r');
        await bridge.copyFile(server, from, to, { recursive });
        console.log(`  ✓ Copied ${from} → ${to}`);
        break;
      }

      case 'tree':
      case 'project': {
        const server = args[1], path = args[2] || '.';
        if (!server) { console.error('Usage: remotex tree <server> [path]'); process.exit(1); }
        const r = await bridge.getProjectStructure(server, path);
        console.log(`\n  Project: ${r.root}`);
        console.log(`  ${r.totalFiles} files, ${r.totalDirs} dirs, ${r.totalSizeKB} KB\n`);
        if (r.keyFiles.length) {
          console.log(`  Key files: ${r.keyFiles.join(', ')}\n`);
        }
        for (const e of r.tree.slice(0, 80)) {
          const indent = '  '.repeat(e.depth);
          const icon = e.type === 'dir' ? '📁' : '  ';
          console.log(`  ${indent}${icon} ${e.path.split('/').pop()}`);
        }
        if (r.tree.length > 80) console.log(`  ... and ${r.tree.length - 80} more`);
        console.log();
        break;
      }

      // ── Batch Import / Batch File Ops ──

      case 'import': {
        const filePath = args[1];
        if (!filePath) { console.error('Usage: remotex import <file> [--overwrite] [--group name]'); process.exit(1); }
        const overwrite = args.includes('--overwrite');
        const groupIdx = args.indexOf('--group');
        const defaultGroup = groupIdx > 0 ? args[groupIdx + 1] : 'imported';
        const r = bridge.importServersFromFile(filePath, { overwrite, defaultGroup });
        console.log(`\n  ✓ Imported: ${r.imported}, Skipped: ${r.skipped}, Total: ${r.total}`);
        if (r.errors.length) {
          console.log(`  Errors:`);
          for (const e of r.errors) console.log(`    - ${e}`);
        }
        console.log();
        break;
      }

      case 'clear-all': {
        const r = bridge.clearAllServers();
        console.log(`  ✓ Cleared ${r.cleared} servers`);
        break;
      }

      case 'batch-cat':
      case 'batch-read': {
        const target = args[1], path = args[2];
        if (!target || !path) { console.error('Usage: remotex batch-cat <group|s1,s2,...> <path>'); process.exit(1); }
        const serverIds = resolveTarget(target);
        console.log(`\n  Reading ${path} from ${serverIds.length} servers...\n`);
        const results = await bridge.batchReadFile(serverIds, path);
        for (const [id, r] of Object.entries(results)) {
          if (r.error) {
            console.log(`  ✗ ${id}: ${r.error}`);
          } else {
            const preview = (r.content || '').split('\n').slice(0, 3).join(' | ').substring(0, 100);
            console.log(`  ✓ ${id.padEnd(25)} ${(r.content || '').split('\n').length} lines  ${preview}...`);
          }
        }
        console.log();
        break;
      }

      case 'batch-write': {
        const target = args[1], path = args[2];
        if (!target || !path) { console.error('Usage: remotex batch-write <group|s1,s2,...> <path> (reads stdin)'); process.exit(1); }
        const serverIds = resolveTarget(target);
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const content = Buffer.concat(chunks).toString('utf-8');
        const noBackup = args.includes('--no-backup');
        console.log(`\n  Writing ${path} to ${serverIds.length} servers (${content.length} bytes)...\n`);
        const results = await bridge.batchWriteFile(serverIds, path, content, { backup: !noBackup });
        for (const [id, r] of Object.entries(results)) {
          const icon = r.error ? '✗' : '✓';
          const msg = r.error || `ok (backup: ${r.backedUp})`;
          console.log(`  ${icon} ${id.padEnd(25)} ${msg}`);
        }
        console.log();
        break;
      }

      case 'batch-replace': {
        const target = args[1], path = args[2], old = args[3], nw = args[4];
        if (!target || !path || !old || nw === undefined) {
          console.error('Usage: remotex batch-replace <group|s1,s2,...> <path> <old_text> <new_text> [--all]');
          process.exit(1);
        }
        const serverIds = resolveTarget(target);
        const all = args.includes('--all');
        console.log(`\n  Replacing in ${path} on ${serverIds.length} servers...\n`);
        const results = await bridge.batchReplaceInFile(serverIds, path, old, nw, { all });
        for (const [id, r] of Object.entries(results)) {
          const icon = r.error ? '✗' : '✓';
          const msg = r.error || `${r.replacements} replacement(s)`;
          console.log(`  ${icon} ${id.padEnd(25)} ${msg}`);
        }
        console.log();
        break;
      }

      case 'status': {
        console.log('\n  Checking all servers...\n');
        const servers = await bridge.listServers(true);
        const online = servers.filter(s => s.status === 'online').length;
        for (const s of servers) {
          const icon = s.status === 'online' ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
          console.log(`  ${icon} ${s.id.padEnd(20)} ${s.host}`);
        }
        console.log(`\n  ${online}/${servers.length} online\n`);
        break;
      }

      case 'help':
      case '--help':
      case '-h':
      case undefined: {
        console.log(`
  remotex — Claude Code SSH Server Manager

  Commands:
    list [-c]                          List servers (add -c to check connectivity)
    status                             Check all servers connectivity
    info <server>                      Detailed system info
    exec <server> <command>            Execute command on server
    batch <group|s1,s2> <command>      Execute on multiple servers
    add <id> <host> [options]          Add server (--user --port --key --group)
    remove <id>                        Remove server
    groups                             List server groups
    upload <server> <local> <remote>   Upload file via SFTP
    download <server> <remote> <local> Download file via SFTP
    tail <server> <logpath> [lines]    Tail remote log file
    service <server> <name> <action>   Manage systemd service
    ports <server>                     List listening ports

  Batch Import:
    import <file> [--overwrite] [--group name]   Import from ip.txt format
    clear-all                                     Remove all servers

  Batch File Ops (批量 vi):
    batch-cat <group|s1,s2> <path>               Read file from multiple servers
    batch-write <group|s1,s2> <path>             Write file to servers (stdin)
    batch-replace <group|s1,s2> <path> <old> <new> [--all]  Replace text

  MCP Server:
    claude mcp add remotex node ${process.argv[1].replace('/bin/cli.js', '/src/mcp-server.js')}

  Config: ~/.remotex.json
`);
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}. Run "remotex help" for usage.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    bridge.disconnectAll();
  }
}

main();
