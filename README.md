# RemoteX v0.4.0

**Claude Code + GUI SSH Client: AI-native batch server management**

The only tool that combines a **visual SSH terminal** (PyQt5), a **Claude Code MCP server** (38 tools), and an **HTTP API** for programmatic control -- all in one package.

## What makes this different

| Feature | RemoteX | mcp-ssh-manager | ssh-mcp-server | SSGui |
|---|---|---|---|---|
| GUI SSH terminal (multi-tab) | Yes | No | No | Yes |
| Claude Code MCP integration | 38 tools | 37 tools | 5 tools | No |
| Batch file editing (batch vi) | Yes | No | No | No |
| HTTP API for AI control | Yes | No | No | No |
| Output capture (Claude reads terminal) | Yes | N/A | N/A | No |
| Config drift detection | Yes | No | No | No |
| System monitoring (health check) | Yes | Yes | No | No |
| Token-efficient operations | Yes | Yes | Yes | N/A |

## Architecture

```
+-------------------+     HTTP API (9876)     +------------------+
|   Claude Code     | <---------------------> |   RemoteX.py     |
|   (AI Agent)      |                         |   PyQt5 GUI      |
+-------------------+                         |   SSH Terminals   |
        |                                     +------------------+
        | MCP (stdio)                                |
        v                                            | paramiko SSH
+-------------------+                                v
|   mcp-server.js   |                         +-----------+
|   38 tools        | -------- ssh2 -------> | Servers    |
|   bridge.js       |                         | (N hosts)  |
+-------------------+                         +-----------+
```

## Quick Start

### 1. Install dependencies

```bash
# Node.js MCP server
cd RemoteX && npm install

# Python GUI client
pip install -r requirements.txt
```

### 2. Add servers

```bash
# Method A: Import from ip.txt (format: name,host,port,user,pass,group)
npx remotex import ip.txt

# Method B: Add individually
npx remotex add prod-01 10.0.0.1 --user root --port 22 --group production
```

### 3. Register MCP with Claude Code

```bash
claude mcp add remotex node /path/to/RemoteX/src/mcp-server.js
```

### 4. Launch GUI with auto-connect

```bash
# Open all servers matching "SMAPP"
python RemoteX.py --import ip.txt --filter SMAPP

# Claude Code can now control the GUI via HTTP API
curl http://localhost:9876/sessions
```

## MCP Tools (38)

### Core SSH Operations
| Tool | Description |
|---|---|
| `ssh_exec` | Execute command on a server |
| `ssh_exec_batch` | Execute command on multiple servers |
| `ssh_list_servers` | List all configured servers |
| `ssh_list_groups` | List server groups |
| `ssh_add_server` | Add a server |
| `ssh_remove_server` | Remove a server |

### File Operations
| Tool | Description |
|---|---|
| `ssh_read_file` | Read a remote file (with line range support) |
| `ssh_write_file` | Write/append/insert to a remote file |
| `ssh_replace_in_file` | Find & replace text in a file |
| `ssh_edit_block` | Edit a text block without full rewrite (token-efficient) |
| `ssh_search_code` | Grep/search code with context |
| `ssh_upload_file` | Upload via SFTP |
| `ssh_download_file` | Download via SFTP |
| `ssh_list_dir` | List directory contents |
| `ssh_find_files` | Search by filename or content |
| `ssh_stat_file` | File metadata (size, perms, mtime) |
| `ssh_mkdir` | Create directory |
| `ssh_delete_file` | Delete file/directory (safety guards) |
| `ssh_move_file` | Move/rename |
| `ssh_copy_file` | Copy file/directory |
| `ssh_project_structure` | Project directory tree |

### Batch Operations (batch vi / batch sed)
| Tool | Description |
|---|---|
| `ssh_import_servers` | Import from ip.txt |
| `ssh_clear_all_servers` | Remove all servers from config |
| `ssh_batch_read_file` | Read same file from N servers |
| `ssh_batch_write_file` | Write same file to N servers |
| `ssh_batch_replace_in_file` | Find/replace across N servers |
| `ssh_diff_files` | Compare same file across servers (drift detection) |
| `ssh_batch_upload` | Upload to multiple servers |
| `ssh_sync_file` | Copy file between servers |

### System Monitoring
| Tool | Description |
|---|---|
| `ssh_server_info` | Full system info |
| `ssh_health_check` | CPU, memory, disk, load, uptime |
| `ssh_batch_health_check` | Health check across N servers |
| `ssh_process_list` | Top processes (filterable) |
| `ssh_docker_status` | Docker containers, images, stats |
| `ssh_network_info` | Interfaces, routes, connections, DNS |
| `ssh_service` | Start/stop/restart systemd services |
| `ssh_ports` | List listening ports |
| `ssh_tail_log` | Tail remote log files |

## RemoteX.py HTTP API

When running RemoteX.py, an HTTP API server starts on port 9876 (configurable with `--port`).

### Read Operations
```bash
# List open sessions
curl http://localhost:9876/sessions

# Read output from a specific session (last 50 lines)
curl "http://localhost:9876/output?server=SMAPP1&lines=50"

# Read output from ALL sessions
curl "http://localhost:9876/output_all?lines=20"

# Execute and wait for output (synchronous)
curl "http://localhost:9876/exec?server=SMAPP1&command=hostname&wait=2"
```

### Write Operations
```bash
# Send command to specific server
curl -X POST http://localhost:9876/send -d '{"server":"SMAPP1","command":"df -h"}'

# Broadcast to all sessions
curl -X POST http://localhost:9876/broadcast -d '{"command":"uptime"}'

# Send to servers matching a filter
curl -X POST http://localhost:9876/send_multi -d '{"filter":"SMAPP","command":"free -m"}'

# Execute on all and collect output
curl -X POST http://localhost:9876/exec_all -d '{"command":"hostname","wait":3}'

# Open new server connections
curl -X POST http://localhost:9876/open -d '{"filter":"IVR"}'

# Close a session
curl -X POST http://localhost:9876/close -d '{"server":"SMAPP1"}'
```

## Typical Workflows

### Batch config modification (batch vi)
```
1. ssh_batch_read_file   -> Read config from all servers
2. ssh_diff_files        -> Check for drift
3. ssh_batch_replace_in_file -> Apply change
4. ssh_batch_read_file   -> Verify
5. ssh_exec_batch        -> Restart services
```

### Fleet health monitoring
```
1. ssh_batch_health_check -> CPU/mem/disk overview
2. ssh_process_list      -> Investigate high-load server
3. ssh_docker_status     -> Check container health
4. ssh_tail_log          -> Read error logs
```

### Deploy script to fleet
```
1. ssh_batch_write_file  -> Write script to all servers
2. ssh_exec_batch        -> chmod +x && run script
3. ssh_exec_all (API)    -> Monitor output in GUI
```

## ip.txt Format

```
# name,host,port,username,password,group
prod-web-01,10.0.1.10,22,root,password,production
prod-web-02,10.0.1.11,22,root,password,production
staging-01,10.0.2.10,22,deploy,password,staging
```

## CLI Commands

```bash
npx remotex list [-c]              # List servers (check connectivity)
npx remotex status                 # Check all servers
npx remotex exec <server> <cmd>    # Execute command
npx remotex batch <group> <cmd>    # Batch execute
npx remotex import <file>          # Import from ip.txt
npx remotex batch-cat <group> <path>   # Batch read file
npx remotex batch-write <group> <path> # Batch write (stdin)
npx remotex batch-replace <group> <path> <old> <new>  # Batch replace
```

## License

MIT
