#!/usr/bin/env node
/**
 * RemoteX MCP Server
 *
 * Model Context Protocol server that gives Claude Code full control
 * over SSH servers. 30+ tools for fleet management.
 *
 * Install:
 *   claude mcp add remotex node /path/to/RemoteX/src/mcp-server.js
 *
 * This implements MCP over stdio transport.
 */

import * as bridge from './bridge.js';

// ═══════════════════════════════════════════════════
// MCP Protocol Implementation (stdio)
// ═══════════════════════════════════════════════════

const TOOLS = [
  {
    name: 'ssh_exec',
    description: 'Execute a command on a remote server via SSH. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID (e.g. "prod-01")' },
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['server', 'command'],
    },
  },
  {
    name: 'ssh_exec_batch',
    description: 'Execute a command on multiple servers in parallel. Specify server IDs or a group name.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'List of server IDs' },
        group: { type: 'string', description: 'Server group name (alternative to servers list)' },
        command: { type: 'string', description: 'Shell command to execute on all servers' },
        concurrency: { type: 'number', description: 'Max parallel connections (default 10)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ssh_server_info',
    description: 'Get comprehensive system info: CPU, memory, disk, uptime, OS, load, ports, Docker containers.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
      },
      required: ['server'],
    },
  },
  {
    name: 'ssh_list_servers',
    description: 'List all configured servers with optional live connectivity check.',
    inputSchema: {
      type: 'object',
      properties: {
        check_alive: { type: 'boolean', description: 'Ping each server to check status (slower)' },
      },
    },
  },
  {
    name: 'ssh_list_groups',
    description: 'List server groups and their members.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ssh_add_server',
    description: 'Add a new server to the configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Server ID (short name, e.g. "prod-01")' },
        host: { type: 'string', description: 'Hostname or IP' },
        port: { type: 'number', description: 'SSH port (default 22)' },
        username: { type: 'string', description: 'SSH username (default "root")' },
        privateKey: { type: 'string', description: 'Path to private key (e.g. "~/.ssh/id_rsa")' },
        password: { type: 'string', description: 'SSH password (if no key)' },
        group: { type: 'string', description: 'Server group (default "default")' },
      },
      required: ['id', 'host'],
    },
  },
  {
    name: 'ssh_remove_server',
    description: 'Remove a server from configuration and close its connection.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Server ID to remove' },
      },
      required: ['id'],
    },
  },
  {
    name: 'ssh_upload_file',
    description: 'Upload a local file to a remote server via SFTP.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        local_path: { type: 'string', description: 'Local file path' },
        remote_path: { type: 'string', description: 'Remote destination path' },
      },
      required: ['server', 'local_path', 'remote_path'],
    },
  },
  {
    name: 'ssh_download_file',
    description: 'Download a file from a remote server via SFTP.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        remote_path: { type: 'string', description: 'Remote file path' },
        local_path: { type: 'string', description: 'Local destination path' },
      },
      required: ['server', 'remote_path', 'local_path'],
    },
  },
  {
    name: 'ssh_tail_log',
    description: 'Get the last N lines of a log file on a remote server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        log_path: { type: 'string', description: 'Path to log file' },
        lines: { type: 'number', description: 'Number of lines (default 50)' },
      },
      required: ['server', 'log_path'],
    },
  },
  {
    name: 'ssh_service',
    description: 'Manage a systemd service: start, stop, restart, status, enable, disable.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        service: { type: 'string', description: 'Service name (e.g. "nginx")' },
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'status', 'enable', 'disable'], description: 'Action to perform' },
      },
      required: ['server', 'service', 'action'],
    },
  },
  {
    name: 'ssh_ports',
    description: 'List all listening ports with associated processes on a server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
      },
      required: ['server'],
    },
  },
  // ── Remote File Operations (Claude Code 远程开发核心) ──
  {
    name: 'ssh_read_file',
    description: 'Read a file from a remote server. Returns file content. Supports line range for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Absolute path to file on remote server' },
        start_line: { type: 'number', description: 'Start reading from this line (1-indexed, optional)' },
        end_line: { type: 'number', description: 'Stop reading at this line (optional)' },
      },
      required: ['server', 'path'],
    },
  },
  {
    name: 'ssh_write_file',
    description: 'Write content to a file on a remote server. Creates parent directories automatically. Backs up original file by default.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Absolute path to file on remote server' },
        content: { type: 'string', description: 'File content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'insert'], description: 'Write mode (default: overwrite)' },
        insert_at_line: { type: 'number', description: 'Line number to insert at (for insert mode)' },
        backup: { type: 'boolean', description: 'Back up original file (default: true)' },
        permissions: { type: 'string', description: 'File permissions (e.g. "644", "755")' },
      },
      required: ['server', 'path', 'content'],
    },
  },
  {
    name: 'ssh_replace_in_file',
    description: 'Find and replace text in a remote file. Like str_replace but on a remote server. Errors if text not found or ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Absolute path to file' },
        old_text: { type: 'string', description: 'Text to find (must be unique in file unless replace_all is true)' },
        new_text: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false, errors if multiple matches)' },
      },
      required: ['server', 'path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'ssh_list_dir',
    description: 'List directory contents on a remote server. Returns files with type, size, permissions, owner.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Directory path' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        max_depth: { type: 'number', description: 'Max depth for recursive listing (default: 3)' },
        show_hidden: { type: 'boolean', description: 'Show hidden files (default: false)' },
        pattern: { type: 'string', description: 'Filename pattern filter (e.g. "*.py", "*.conf")' },
      },
      required: ['server', 'path'],
    },
  },
  {
    name: 'ssh_find_files',
    description: 'Search for files by name pattern or content (grep). Essential for understanding remote codebases.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        search_path: { type: 'string', description: 'Directory to search in' },
        name_pattern: { type: 'string', description: 'Filename glob pattern (e.g. "*.py", "nginx*")' },
        content_pattern: { type: 'string', description: 'Search for this text inside files (grep)' },
        file_type: { type: 'string', description: 'Limit content search to file type (e.g. "*.js", "*.conf")' },
        max_results: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: ['server', 'search_path'],
    },
  },
  {
    name: 'ssh_stat_file',
    description: 'Get file metadata: size, permissions, owner, modification time, type.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'File path' },
      },
      required: ['server', 'path'],
    },
  },
  {
    name: 'ssh_mkdir',
    description: 'Create a directory on a remote server (with parent directories).',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Directory path to create' },
        permissions: { type: 'string', description: 'Permissions (e.g. "755")' },
      },
      required: ['server', 'path'],
    },
  },
  {
    name: 'ssh_delete_file',
    description: 'Delete a file or directory on a remote server. Has safety guards against dangerous paths.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Path to delete' },
        recursive: { type: 'boolean', description: 'Delete directory recursively (default: false)' },
      },
      required: ['server', 'path'],
    },
  },
  {
    name: 'ssh_move_file',
    description: 'Move or rename a file/directory on a remote server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        from_path: { type: 'string', description: 'Source path' },
        to_path: { type: 'string', description: 'Destination path' },
      },
      required: ['server', 'from_path', 'to_path'],
    },
  },
  {
    name: 'ssh_copy_file',
    description: 'Copy a file or directory on a remote server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        from_path: { type: 'string', description: 'Source path' },
        to_path: { type: 'string', description: 'Destination path' },
        recursive: { type: 'boolean', description: 'Copy directory recursively' },
      },
      required: ['server', 'from_path', 'to_path'],
    },
  },
  {
    name: 'ssh_project_structure',
    description: 'Get a project directory overview optimized for AI context. Returns file tree, key files (README, Makefile, package.json, etc.), and size summary. Use this first when working on a remote project.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'Project root directory' },
        max_depth: { type: 'number', description: 'Max directory depth (default: 4)' },
      },
      required: ['server', 'path'],
    },
  },
  // ── Batch Import / Batch File Ops (批量运维核心) ──
  {
    name: 'ssh_import_servers',
    description: 'Import servers from a text file (ip.txt format). Each line: name,host,port,username,password,group. Lines starting with # are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the server list file (e.g. ip.txt)' },
        overwrite: { type: 'boolean', description: 'Overwrite existing servers with same ID (default: false)' },
        default_group: { type: 'string', description: 'Default group for servers without a group field (default: "imported")' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'ssh_clear_all_servers',
    description: 'Remove ALL servers from configuration. Use with caution.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ssh_batch_read_file',
    description: 'Read the same file from multiple servers in parallel. Returns content per server. Great for comparing configs across servers.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'List of server IDs' },
        group: { type: 'string', description: 'Server group name (alternative to servers list)' },
        path: { type: 'string', description: 'Absolute path to file on remote servers' },
        start_line: { type: 'number', description: 'Start line (optional)' },
        end_line: { type: 'number', description: 'End line (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ssh_batch_write_file',
    description: 'Write the same content to the same file on multiple servers in parallel. Like "batch vi" — deploy a config file to all servers at once.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'List of server IDs' },
        group: { type: 'string', description: 'Server group name (alternative to servers list)' },
        path: { type: 'string', description: 'Absolute path to file on remote servers' },
        content: { type: 'string', description: 'File content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'insert'], description: 'Write mode (default: overwrite)' },
        backup: { type: 'boolean', description: 'Back up original file (default: true)' },
        permissions: { type: 'string', description: 'File permissions (e.g. "644")' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'ssh_batch_replace_in_file',
    description: 'Find and replace text in the same file on multiple servers in parallel. Like "batch sed" — update a config value across all servers.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'List of server IDs' },
        group: { type: 'string', description: 'Server group name (alternative to servers list)' },
        path: { type: 'string', description: 'Absolute path to file' },
        old_text: { type: 'string', description: 'Text to find' },
        new_text: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  // ── Token-Efficient File Operations ──
  {
    name: 'ssh_edit_block',
    description: 'Edit a specific text block in a remote file without rewriting the whole file. 80-90% fewer tokens than full rewrite. Errors if block not found or ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        path: { type: 'string', description: 'File path' },
        old_block: { type: 'string', description: 'Existing text block to find' },
        new_block: { type: 'string', description: 'Replacement text block' },
        backup: { type: 'boolean', description: 'Backup original (default: true)' },
      },
      required: ['server', 'path', 'old_block', 'new_block'],
    },
  },
  {
    name: 'ssh_search_code',
    description: 'Search for a pattern in files on a remote server. Returns matches with context lines. More efficient than reading entire files.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        search_path: { type: 'string', description: 'Directory to search' },
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        file_type: { type: 'string', description: 'File type filter (e.g. "*.py")' },
        context: { type: 'number', description: 'Context lines around match (default: 2)' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive (default: true)' },
        max_results: { type: 'number', description: 'Max results (default: 30)' },
      },
      required: ['server', 'search_path', 'pattern'],
    },
  },
  {
    name: 'ssh_diff_files',
    description: 'Compare the same file across multiple servers. Detects config drift by showing which servers differ and where.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'Server IDs to compare' },
        group: { type: 'string', description: 'Server group (alternative)' },
        path: { type: 'string', description: 'File path to compare' },
      },
      required: ['path'],
    },
  },
  // ── System Monitoring ──
  {
    name: 'ssh_health_check',
    description: 'Quick health check: CPU%, memory, disk, load average, uptime — all in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
      },
      required: ['server'],
    },
  },
  {
    name: 'ssh_batch_health_check',
    description: 'Health check across multiple servers in parallel. Great for fleet overview.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'Server IDs' },
        group: { type: 'string', description: 'Server group (alternative)' },
      },
    },
  },
  {
    name: 'ssh_process_list',
    description: 'List top processes by CPU or memory usage, with optional filter.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
        filter: { type: 'string', description: 'Filter processes by name (e.g. "java", "nginx")' },
        sort_by: { type: 'string', enum: ['cpu', 'mem'], description: 'Sort by cpu or mem (default: cpu)' },
        limit: { type: 'number', description: 'Max processes (default: 20)' },
      },
      required: ['server'],
    },
  },
  {
    name: 'ssh_docker_status',
    description: 'Get Docker container status, images, and resource usage on a server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
      },
      required: ['server'],
    },
  },
  {
    name: 'ssh_network_info',
    description: 'Get network info: interfaces, routes, active connections, DNS config.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID' },
      },
      required: ['server'],
    },
  },
  // ── Deployment & Sync ──
  {
    name: 'ssh_batch_upload',
    description: 'Upload a local file to multiple servers in parallel via SFTP.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: 'Server IDs' },
        group: { type: 'string', description: 'Server group (alternative)' },
        local_path: { type: 'string', description: 'Local file path' },
        remote_path: { type: 'string', description: 'Remote destination path' },
      },
      required: ['local_path', 'remote_path'],
    },
  },
  {
    name: 'ssh_sync_file',
    description: 'Copy a file from one server to another (server-to-server via relay).',
    inputSchema: {
      type: 'object',
      properties: {
        from_server: { type: 'string', description: 'Source server ID' },
        to_server: { type: 'string', description: 'Destination server ID' },
        path: { type: 'string', description: 'File path on source server' },
        to_path: { type: 'string', description: 'Destination path (default: same path)' },
      },
      required: ['from_server', 'to_server', 'path'],
    },
  },
];

// ═══════════════════════════════════════════════════
// Tool Dispatcher
// ═══════════════════════════════════════════════════

/**
 * Resolve server IDs from either an explicit list or a group name.
 */
function resolveServerIds(servers, group) {
  let serverIds = servers || [];
  if (group) {
    const groups = bridge.listGroups();
    serverIds = groups[group] || [];
    if (!serverIds.length) throw new Error(`Group "${group}" not found or empty`);
  }
  if (!serverIds.length) throw new Error('No servers specified. Provide servers list or group name.');
  return serverIds;
}

async function handleToolCall(name, args) {
  try {
    switch (name) {
      case 'ssh_exec': {
        const r = await bridge.execCommand(args.server, args.command, args.timeout || 30000);
        return formatResult(r);
      }
      case 'ssh_exec_batch': {
        let serverIds = args.servers || [];
        if (args.group) {
          const groups = bridge.listGroups();
          serverIds = groups[args.group] || [];
          if (!serverIds.length) return formatError(`Group "${args.group}" not found or empty`);
        }
        if (!serverIds.length) return formatError('No servers specified');
        const r = await bridge.execBatch(serverIds, args.command, args.concurrency || 10);
        return formatResult(r);
      }
      case 'ssh_server_info': {
        const r = await bridge.getServerInfo(args.server);
        return formatResult(r);
      }
      case 'ssh_list_servers': {
        const r = await bridge.listServers(args.check_alive || false);
        return formatResult(r);
      }
      case 'ssh_list_groups': {
        return formatResult(bridge.listGroups());
      }
      case 'ssh_add_server': {
        const r = bridge.addServer(args.id, args.host, {
          port: args.port, username: args.username,
          privateKey: args.privateKey, password: args.password, group: args.group,
        });
        return formatResult({ ok: true, server: args.id, config: r });
      }
      case 'ssh_remove_server': {
        bridge.removeServer(args.id);
        return formatResult({ ok: true, removed: args.id });
      }
      case 'ssh_upload_file': {
        const r = await bridge.uploadFile(args.server, args.local_path, args.remote_path);
        return formatResult(r);
      }
      case 'ssh_download_file': {
        const r = await bridge.downloadFile(args.server, args.remote_path, args.local_path);
        return formatResult(r);
      }
      case 'ssh_tail_log': {
        const r = await bridge.tailLog(args.server, args.log_path, args.lines || 50);
        return formatResult(r);
      }
      case 'ssh_service': {
        const r = await bridge.manageService(args.server, args.service, args.action);
        return formatResult(r);
      }
      case 'ssh_ports': {
        const r = await bridge.getListeningPorts(args.server);
        return formatResult(r);
      }
      // ── Remote File Operations ──
      case 'ssh_read_file': {
        const r = await bridge.readFile(args.server, args.path, {
          startLine: args.start_line, endLine: args.end_line,
        });
        return formatResult(r);
      }
      case 'ssh_write_file': {
        const r = await bridge.writeFile(args.server, args.path, args.content, {
          mode: args.mode || 'overwrite',
          insertAtLine: args.insert_at_line,
          backup: args.backup !== false,
          permissions: args.permissions,
        });
        return formatResult(r);
      }
      case 'ssh_replace_in_file': {
        const r = await bridge.replaceInFile(args.server, args.path, args.old_text, args.new_text, {
          all: args.replace_all || false,
        });
        return formatResult(r);
      }
      case 'ssh_list_dir': {
        const r = await bridge.listDir(args.server, args.path, {
          recursive: args.recursive, maxDepth: args.max_depth,
          showHidden: args.show_hidden, pattern: args.pattern,
        });
        return formatResult(r);
      }
      case 'ssh_find_files': {
        const r = await bridge.findFiles(args.server, args.search_path, {
          namePattern: args.name_pattern, contentPattern: args.content_pattern,
          fileType: args.file_type, maxResults: args.max_results,
        });
        return formatResult(r);
      }
      case 'ssh_stat_file': {
        const r = await bridge.statFile(args.server, args.path);
        return formatResult(r);
      }
      case 'ssh_mkdir': {
        const r = await bridge.mkDir(args.server, args.path, { permissions: args.permissions });
        return formatResult(r);
      }
      case 'ssh_delete_file': {
        const r = await bridge.deleteFile(args.server, args.path, { recursive: args.recursive });
        return formatResult(r);
      }
      case 'ssh_move_file': {
        const r = await bridge.moveFile(args.server, args.from_path, args.to_path);
        return formatResult(r);
      }
      case 'ssh_copy_file': {
        const r = await bridge.copyFile(args.server, args.from_path, args.to_path, { recursive: args.recursive });
        return formatResult(r);
      }
      case 'ssh_project_structure': {
        const r = await bridge.getProjectStructure(args.server, args.path, { maxDepth: args.max_depth });
        return formatResult(r);
      }
      // ── Batch Import / Batch File Ops ──
      case 'ssh_import_servers': {
        const r = bridge.importServersFromFile(args.file_path, {
          overwrite: args.overwrite || false,
          defaultGroup: args.default_group || 'imported',
        });
        return formatResult(r);
      }
      case 'ssh_clear_all_servers': {
        const r = bridge.clearAllServers();
        return formatResult(r);
      }
      case 'ssh_batch_read_file': {
        const serverIds = await resolveServerIds(args.servers, args.group);
        const r = await bridge.batchReadFile(serverIds, args.path, {
          startLine: args.start_line, endLine: args.end_line,
        });
        return formatResult(r);
      }
      case 'ssh_batch_write_file': {
        const serverIds = await resolveServerIds(args.servers, args.group);
        const r = await bridge.batchWriteFile(serverIds, args.path, args.content, {
          mode: args.mode || 'overwrite',
          backup: args.backup !== false,
          permissions: args.permissions,
        });
        return formatResult(r);
      }
      case 'ssh_batch_replace_in_file': {
        const serverIds = await resolveServerIds(args.servers, args.group);
        const r = await bridge.batchReplaceInFile(serverIds, args.path, args.old_text, args.new_text, {
          all: args.replace_all || false,
        });
        return formatResult(r);
      }
      // ── Token-Efficient File Ops ──
      case 'ssh_edit_block': {
        const r = await bridge.editBlock(args.server, args.path, args.old_block, args.new_block, {
          backup: args.backup !== false,
        });
        return formatResult(r);
      }
      case 'ssh_search_code': {
        const r = await bridge.searchCode(args.server, args.search_path, args.pattern, {
          fileType: args.file_type, context: args.context,
          caseSensitive: args.case_sensitive !== false, maxResults: args.max_results,
        });
        return formatResult(r);
      }
      case 'ssh_diff_files': {
        const serverIds = resolveServerIds(args.servers, args.group);
        const r = await bridge.diffFileAcrossServers(serverIds, args.path);
        return formatResult(r);
      }
      // ── System Monitoring ──
      case 'ssh_health_check': {
        const r = await bridge.healthCheck(args.server);
        return formatResult(r);
      }
      case 'ssh_batch_health_check': {
        const serverIds = resolveServerIds(args.servers, args.group);
        const r = await bridge.batchHealthCheck(serverIds);
        return formatResult(r);
      }
      case 'ssh_process_list': {
        const r = await bridge.processList(args.server, {
          filter: args.filter, sortBy: args.sort_by, limit: args.limit,
        });
        return formatResult(r);
      }
      case 'ssh_docker_status': {
        const r = await bridge.dockerStatus(args.server);
        return formatResult(r);
      }
      case 'ssh_network_info': {
        const r = await bridge.networkInfo(args.server);
        return formatResult(r);
      }
      // ── Deployment & Sync ──
      case 'ssh_batch_upload': {
        const serverIds = resolveServerIds(args.servers, args.group);
        const r = await bridge.batchUploadFile(serverIds, args.local_path, args.remote_path);
        return formatResult(r);
      }
      case 'ssh_sync_file': {
        const r = await bridge.syncFileBetweenServers(args.from_server, args.to_server, args.path, {
          toPath: args.to_path,
        });
        return formatResult(r);
      }
      default:
        return formatError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return formatError(err.message);
  }
}

function formatResult(data) {
  return [{ type: 'text', text: JSON.stringify(data, null, 2) }];
}

function formatError(msg) {
  return [{ type: 'text', text: JSON.stringify({ error: msg }) }];
}

// ═══════════════════════════════════════════════════
// MCP stdio Transport
// ═══════════════════════════════════════════════════

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  processBuffer();
});

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

    const contentLength = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) return;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body);
      handleMessage(msg);
    } catch (e) {
      sendError(null, -32700, 'Parse error');
    }
  }
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

async function handleMessage(msg) {
  const { method, params, id } = msg;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'remotex', version: '0.4.0' },
    });
  } else if (method === 'notifications/initialized') {
    // No response needed
  } else if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const content = await handleToolCall(name, args || {});
    sendResponse(id, { content });
  } else if (method === 'ping') {
    sendResponse(id, {});
  } else if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// Keep alive
process.stdin.on('end', () => {
  bridge.disconnectAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  bridge.disconnectAll();
  process.exit(0);
});
