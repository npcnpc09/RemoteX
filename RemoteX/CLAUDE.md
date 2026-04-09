# RemoteX v0.4.0 — AI-Native SSH Fleet Management for Claude Code

You have MCP tools (38) to operate on remote servers via SSH, plus an HTTP API to control the RemoteX GUI terminal.

## Architecture

```
Claude Code ──MCP (stdio)──> mcp-server.js (38 tools) ──ssh2──> Servers
Claude Code ──curl──> RemoteX.py HTTP API (:9876) ──paramiko──> Servers (with live GUI)
```

## Quick Reference: Which Tool to Use

| I want to... | Use |
|---|---|
| Run a command on 1 server | `ssh_exec` |
| Run a command on N servers | `ssh_exec_batch` |
| Read a file | `ssh_read_file` (line range support) |
| Edit part of a file | `ssh_edit_block` (token-efficient) |
| Search code | `ssh_search_code` (grep with context) |
| Write same file to N servers | `ssh_batch_write_file` |
| Find/replace across N servers | `ssh_batch_replace_in_file` |
| Check if configs match | `ssh_diff_files` |
| Monitor server health | `ssh_health_check` / `ssh_batch_health_check` |
| Check Docker | `ssh_docker_status` |
| Deploy a file to fleet | `ssh_batch_upload` or `ssh_batch_write_file` |
| Copy file between servers | `ssh_sync_file` |
| Control GUI terminal | `curl http://localhost:9876/...` |

---

## All MCP Tools (38)

### Server Management
| Tool | Purpose |
|---|---|
| `ssh_exec` | Execute any command on a server |
| `ssh_exec_batch` | Execute on multiple servers (by group or list) |
| `ssh_server_info` | CPU, memory, disk, uptime, ports |
| `ssh_list_servers` | List all configured servers |
| `ssh_list_groups` | List server groups |
| `ssh_add_server` | Add a server to config |
| `ssh_remove_server` | Remove a server |
| `ssh_import_servers` | Import from ip.txt |
| `ssh_clear_all_servers` | Remove all servers from config |

### File Operations
| Tool | Purpose |
|---|---|
| `ssh_read_file` | Read file content (supports line ranges) |
| `ssh_write_file` | Write/overwrite/append file (auto-backup, auto-mkdir) |
| `ssh_replace_in_file` | Find and replace text in a file |
| `ssh_edit_block` | Edit specific text block (80-90% fewer tokens) |
| `ssh_search_code` | Search pattern in files with context lines |
| `ssh_list_dir` | List directory contents |
| `ssh_find_files` | Search by filename or content |
| `ssh_stat_file` | File metadata (size, perms, mtime) |
| `ssh_mkdir` | Create directory |
| `ssh_delete_file` | Delete file/directory (safety guards) |
| `ssh_move_file` | Move/rename |
| `ssh_copy_file` | Copy file/directory |
| `ssh_upload_file` | Upload local -> server (SFTP) |
| `ssh_download_file` | Download server -> local (SFTP) |
| `ssh_project_structure` | Project tree + key files overview |

### Batch Operations (Batch vi / Batch sed)
| Tool | Purpose |
|---|---|
| `ssh_batch_read_file` | Read same file from N servers |
| `ssh_batch_write_file` | Write same file to N servers |
| `ssh_batch_replace_in_file` | Find/replace in file on N servers |
| `ssh_diff_files` | Compare file across servers (drift detection) |
| `ssh_batch_upload` | Upload local file to N servers |
| `ssh_sync_file` | Copy file between two servers |

### System Monitoring
| Tool | Purpose |
|---|---|
| `ssh_health_check` | CPU, mem, disk, load, uptime (one call) |
| `ssh_batch_health_check` | Health check across N servers |
| `ssh_process_list` | Top processes (sort by cpu/mem, filter) |
| `ssh_docker_status` | Docker containers, images, stats |
| `ssh_network_info` | Interfaces, routes, connections, DNS |
| `ssh_service` | start/stop/restart systemd services |
| `ssh_ports` | List listening ports |
| `ssh_tail_log` | Read last N lines of a log file |

---

## RemoteX.py HTTP API (GUI Terminal Control)

When RemoteX.py is running, Claude can control it via HTTP API on port 9876.

### Read (GET)
```bash
# List sessions
curl http://localhost:9876/sessions

# Read terminal output from a session
curl "http://localhost:9876/output?server=SMAPP1&lines=50"

# Read output from ALL sessions
curl "http://localhost:9876/output_all?lines=20"

# Execute command and wait for output
curl "http://localhost:9876/exec?server=SMAPP1&command=hostname&wait=2"
```

### Write (POST)
```bash
# Send command to specific server
curl -X POST http://localhost:9876/send -d '{"server":"SMAPP1","command":"ls"}'

# Broadcast to all sessions
curl -X POST http://localhost:9876/broadcast -d '{"command":"uptime"}'

# Send to matching servers
curl -X POST http://localhost:9876/send_multi -d '{"filter":"SMAPP","command":"df -h"}'

# Execute and collect output from all
curl -X POST http://localhost:9876/exec_all -d '{"command":"hostname","wait":3}'

# Execute and wait for output (single server)
curl -X POST http://localhost:9876/exec_wait -d '{"server":"SMAPP1","command":"hostname","wait":2}'

# Open connections by filter
curl -X POST http://localhost:9876/open -d '{"filter":"IVR"}'

# Close session
curl -X POST http://localhost:9876/close -d '{"server":"SMAPP1"}'
```

---

## Typical Workflows

### 1. Batch config modification (batch vi)
```
ssh_batch_read_file          -> Read config from all servers
ssh_diff_files               -> Check for drift
ssh_batch_replace_in_file    -> Apply change
ssh_batch_read_file          -> Verify change
ssh_exec_batch               -> Restart services
```

### 2. Fleet health monitoring
```
ssh_batch_health_check       -> CPU/mem/disk overview
ssh_process_list             -> Investigate high-load server
ssh_docker_status            -> Check container health
ssh_tail_log                 -> Read error logs
```

### 3. Deploy script to fleet
```
ssh_batch_write_file         -> Write script to all servers
ssh_exec_batch               -> chmod +x && run
```

### 4. Interactive session via RemoteX GUI
```
curl POST /open              -> Open connections
curl POST /broadcast         -> Send commands
curl GET  /output_all        -> Read results
curl POST /exec_all          -> Execute and collect output
```

### 5. Import servers from ip.txt
```
ssh_import_servers  file_path="ip.txt"
ssh_list_groups
ssh_batch_health_check  group=production
```

---

## Safety Rules
- `ssh_write_file` backs up original as `.bak` by default
- `ssh_edit_block` errors if block not found or matches multiple times
- `ssh_replace_in_file` errors if old_text not found (unless replace_all)
- `ssh_delete_file` refuses dangerous paths (/, /etc, /usr, etc.)
- Always test config before restarting (e.g. `nginx -t`)
- Use `ssh_read_file` / `ssh_batch_read_file` to verify after writing
- Use `ssh_diff_files` to detect config drift before making changes

## Config
Stored at `~/.remotex.json`:
```json
{
  "servers": {
    "prod-01": { "host": "10.1.1.10", "port": 22, "username": "root", "password": "...", "group": "production" }
  }
}
```

## ip.txt Format
```
# name,host,port,username,password,group
prod-web-01,10.0.1.10,22,root,password,production
prod-web-02,10.0.1.11,22,root,password,production
```
