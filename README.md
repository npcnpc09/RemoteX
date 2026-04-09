# RemoteX v0.4.0

**AI-native SSH fleet management: Desktop GUI + Mobile Web Terminal + Claude Code MCP**

The only tool that combines a **visual SSH terminal** (PyQt5), a **Claude Code MCP server** (38 tools), a **mobile web terminal** (xterm.js), and an **AI Chat** for natural language server management -- all in one package.

## Screenshots

### Web Terminal & AI Chat (Desktop Browser)

| Login | Server List | Terminal | AI Chat |
|:---:|:---:|:---:|:---:|
| ![Login](screenshots/web-login.png) | ![Servers](screenshots/web-servers.png) | ![Terminal](screenshots/web-terminal.png) | ![AI Chat](screenshots/web-ai-chat.png) |

### Mobile Web Terminal (Phone)

| Server List | SSH Terminal | AI Chat |
|:---:|:---:|:---:|
| ![Servers](screenshots/mobile-servers.png) | ![Terminal](screenshots/mobile-terminal.png) | ![AI Chat](screenshots/mobile-ai-chat.png) |

## Features

| Feature | RemoteX | mcp-ssh-manager | ssh-mcp-server | SSGui |
|---|---|---|---|---|
| GUI SSH terminal (multi-tab) | Yes | No | No | Yes |
| **Mobile Web SSH terminal** | **Yes** | No | No | No |
| **AI Chat (natural language)** | **Yes** | No | No | No |
| Claude Code MCP integration | 38 tools | 37 tools | 5 tools | No |
| Batch file editing (batch vi) | Yes | No | No | No |
| HTTP API for AI control | Yes | No | No | No |
| WebSocket real-time terminal | Yes | No | No | No |
| Config drift detection | Yes | No | No | No |
| System monitoring | Yes | Yes | No | No |

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
        
+-------------------+     WebSocket (9877)    +------------------+
|   Mobile Browser  | <---------------------> |   RemoteX.py     |
|   xterm.js        |                         |   Web Terminal   |
|   AI Chat         | ---- HTTP API (9876) -> |   Claude CLI     |
+-------------------+                         +------------------+
```

## Quick Start

### 1. Install dependencies

```bash
# Node.js MCP server
cd RemoteX && npm install

# Python GUI + Web terminal
pip install -r requirements.txt
```

### 2. Add servers

Create `ssh_config.json` in the project root:
```json
[
  {"name": "prod-01", "host": "10.0.1.10", "port": 22, "username": "root", "password": "xxx", "group": "production"},
  {"name": "prod-02", "host": "10.0.1.11", "port": 22, "username": "root", "password": "xxx", "group": "production"}
]
```

Or import from ip.txt:
```bash
# format: name,host,port,username,password,group
npx remotex import ip.txt
```

### 3. Launch

```bash
python RemoteX.py
```

This starts:
- **Desktop GUI** on screen (PyQt5 multi-tab SSH terminal)
- **HTTP API** on `http://0.0.0.0:9876`
- **WebSocket terminal** on `ws://0.0.0.0:9877`

### 4. Mobile access

Open on your phone (same network):
```
http://<your-pc-ip>:9876/terminal
```

Three tabs available:
- **Servers** -- browse and connect to any configured server
- **Terminals** -- multi-tab xterm.js SSH terminal with quick commands
- **AI Chat** -- natural language server management ("check disk on all SMAPP servers")

### 5. Register MCP with Claude Code

```bash
claude mcp add remotex node /path/to/RemoteX/src/mcp-server.js
```

## Mobile Web Terminal

Access from any device on the same network via `http://<ip>:9876/terminal`.

**Features:**
- Login with Basic Auth (configurable)
- Browse all configured servers with search/filter
- Multi-tab SSH terminals (open multiple servers simultaneously)
- xterm.js with full terminal emulation (colors, cursor, tab completion)
- Quick command bar (ls, df, free, top, docker, Ctrl+C, Tab)
- Independent SSH connections (doesn't affect desktop GUI)
- Responsive design optimized for mobile screens

## AI Chat

Natural language server management powered by Claude. Available in both desktop GUI and mobile web.

**Examples:**
```
"Check disk usage on all SMAPP servers"
"Show memory on SMAPP1"
"Open the sedu4 server on co3s"
"Restart nginx on all production servers"
"List running docker containers"
```

The AI will automatically:
1. Open SSH connections if needed
2. Execute the appropriate commands
3. Summarize results in a mobile-friendly format

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

### Batch Operations
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

## HTTP API

When running RemoteX.py, an HTTP API server starts on port 9876.

### Read Operations
```bash
curl -u admin:password http://localhost:9876/sessions
curl -u admin:password http://localhost:9876/servers
curl -u admin:password "http://localhost:9876/output?server=SERVER&lines=50"
curl -u admin:password "http://localhost:9876/exec?server=SERVER&command=hostname&wait=2"
```

### Write Operations
```bash
curl -u admin:password -X POST http://localhost:9876/send -d '{"server":"SERVER","command":"df -h"}'
curl -u admin:password -X POST http://localhost:9876/broadcast -d '{"command":"uptime"}'
curl -u admin:password -X POST http://localhost:9876/open -d '{"filter":"KEYWORD"}'
curl -u admin:password -X POST http://localhost:9876/exec_all -d '{"command":"hostname","wait":3}'
```

### Web Terminal
```
GET /terminal    -- Mobile web terminal (no auth required for page load)
```

## Typical Workflows

### Batch config modification
```
1. ssh_batch_read_file        -> Read config from all servers
2. ssh_diff_files             -> Check for drift
3. ssh_batch_replace_in_file  -> Apply change
4. ssh_batch_read_file        -> Verify
5. ssh_exec_batch             -> Restart services
```

### Fleet health monitoring
```
1. ssh_batch_health_check     -> CPU/mem/disk overview
2. ssh_process_list           -> Investigate high-load server
3. ssh_docker_status          -> Check container health
4. ssh_tail_log               -> Read error logs
```

### Mobile AI management
```
"Check disk on all SMAPP servers"   -> AI runs df -h on matching servers
"Restart nginx on prod-01"          -> AI opens connection + restarts
"Show top processes on server X"    -> AI runs top and summarizes
```

## Configuration

### ssh_config.json
```json
[
  {
    "name": "server-name",
    "host": "10.0.1.10",
    "port": 22,
    "username": "root",
    "password": "...",
    "group": "production"
  }
]
```

### ip.txt format
```
# name,host,port,username,password,group
prod-web-01,10.0.1.10,22,root,password,production
prod-web-02,10.0.1.11,22,root,password,production
```

### CLI Commands
```bash
npx remotex list [-c]                            # List servers
npx remotex exec <server> <cmd>                  # Execute command
npx remotex batch <group> <cmd>                  # Batch execute
npx remotex import <file>                        # Import from ip.txt
npx remotex batch-cat <group> <path>             # Batch read file
npx remotex batch-replace <group> <path> <old> <new>  # Batch replace
```

## Network Access

### Same Network (LAN)

Mobile and PC on the same WiFi/network:

1. Open firewall ports on PC:
```bash
netsh advfirewall firewall add rule name="RemoteX HTTP" dir=in action=allow protocol=TCP localport=9876
netsh advfirewall firewall add rule name="RemoteX WebSocket" dir=in action=allow protocol=TCP localport=9877
```

2. Find your PC's local IP:
```bash
ipconfig    # Look for 192.168.x.x or 10.x.x.x
```

3. Access from phone:
```
http://192.168.x.x:9876/terminal
```

### Remote Access (Different Network / Internet)

To access RemoteX from anywhere (different WiFi, cellular, remote location), use **[Tailscale](https://tailscale.com)** -- a free mesh VPN that creates a secure tunnel between your devices.

#### Setup

1. **Install Tailscale on PC:**
```bash
winget install Tailscale.Tailscale
```

2. **Install Tailscale on phone:**
   - iOS: [App Store](https://apps.apple.com/app/tailscale/id1470499037)
   - Android: [Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

3. **Login with the same account** on both devices (Google/Microsoft/GitHub)

4. **Find your PC's Tailscale IP:**
```bash
tailscale ip    # Returns 100.x.x.x
```

5. **Access from phone** (works from anywhere):
```
http://100.x.x.x:9876/terminal
```

#### Why Tailscale?

- **Zero config** -- no port forwarding, no dynamic DNS, no public IP needed
- **End-to-end encrypted** -- WireGuard-based, traffic never passes through a relay
- **Works through NAT** -- office firewalls, hotel WiFi, cellular networks
- **Free** for personal use (up to 100 devices)
- **Always on** -- once set up, your phone can always reach your PC

#### Alternative: Cloudflare Tunnel

If you have a domain name and prefer HTTPS access:

```bash
# Install
winget install Cloudflare.cloudflared

# Create tunnel
cloudflared tunnel login
cloudflared tunnel create remotex
cloudflared tunnel route dns remotex ssh.yourdomain.com

# Run (add to startup for persistence)
cloudflared tunnel run --url http://localhost:9876 remotex
```

Then access from anywhere: `https://ssh.yourdomain.com/terminal`

## License

MIT
