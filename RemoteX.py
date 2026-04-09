#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RemoteX.py - 赛博朋克 SSH 客户端 + Claude Code 远程控制

功能：
1. 批量连接测试 / 统一命令输入（广播模式）/ Keepalive
2. --import / --filter 命令行参数：自动导入服务器、自动打开匹配的连接
3. 内置 HTTP API (默认端口 9876)：Claude Code 可通过 curl 远程控制每台会话

用法：
  python RemoteX.py                                    # 正常启动
  python RemoteX.py --import ip.txt                    # 启动并导入服务器
  python RemoteX.py --import ip.txt --filter SMAPP     # 导入并自动打开 SMAPP 相关服务器
  python RemoteX.py --filter SMAPP --port 9876         # 指定 API 端口

Claude Code 控制 API：
  curl http://localhost:9876/sessions                              # 列出所有打开的会话
  curl -X POST http://localhost:9876/send -d '{"server":"xxx","command":"ls"}'  # 发送命令到指定会话
  curl -X POST http://localhost:9876/broadcast -d '{"command":"uptime"}'        # 广播命令到所有会话
  curl -X POST http://localhost:9876/open -d '{"filter":"SMAPP"}'              # 打开匹配的服务器
  curl -X POST http://localhost:9876/close -d '{"server":"xxx"}'               # 关闭指定会话
"""

import sys
import json
import os
import threading
import paramiko
import time
import re
import socket
import argparse
import logging
import subprocess
import asyncio
import base64
from collections import deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

# ==================== 日志系统 ====================

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, f'remotex_{time.strftime("%Y%m%d")}.log')

logger = logging.getLogger('RemoteX')
logger.setLevel(logging.DEBUG)

# 文件日志（详细）
fh = logging.FileHandler(LOG_FILE, encoding='utf-8')
fh.setLevel(logging.DEBUG)
fh.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
logger.addHandler(fh)

# 控制台日志（简略）
ch = logging.StreamHandler()
ch.setLevel(logging.INFO)
ch.setFormatter(logging.Formatter('[%(levelname)s] %(message)s'))
logger.addHandler(ch)
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, 
                             QHBoxLayout, QPushButton, QTreeWidget, QTreeWidgetItem,
                             QSplitter, QTextEdit, QLabel, QDialog, QLineEdit, 
                             QFormLayout, QFileDialog, QMessageBox, QTabWidget,
                             QToolBar, QStatusBar, QProgressDialog, QCheckBox,
                             QScrollArea)
from PyQt5.QtCore import Qt, pyqtSignal, QObject, QEvent, QThread
from PyQt5.QtGui import QFont, QTextCursor, QColor, QKeyEvent


# ==================== 服务器配置管理 ====================

class ServerConfig:
    def __init__(self, name, host, port, username, password, group="Default"):
        self.name = name
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.group = group
    
    def to_dict(self):
        return {
            'name': self.name,
            'host': self.host,
            'port': self.port,
            'username': self.username,
            'password': self.password,
            'group': self.group
        }
    
    @staticmethod
    def from_dict(data):
        return ServerConfig(
            data['name'], data['host'], data['port'],
            data['username'], data['password'],
            data.get('group', 'Default')
        )


class ServerManager:
    def __init__(self, config_file='ssh_config.json'):
        self.config_file = config_file
        self.servers = []
        self.load_config()
    
    def load_config(self):
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self.servers = [ServerConfig.from_dict(s) for s in data]
            except Exception as e:
                logger.error(f"Failed to load config {self.config_file}: {e}")
                self.servers = []
    
    def save_config(self):
        with open(self.config_file, 'w', encoding='utf-8') as f:
            data = [s.to_dict() for s in self.servers]
            json.dump(data, f, indent=2, ensure_ascii=False)
    
    def add_server(self, server):
        self.servers.append(server)
        self.save_config()
    
    def remove_server(self, index):
        if 0 <= index < len(self.servers):
            del self.servers[index]
            self.save_config()
    
    def clear_all(self):
        """清空所有服务器"""
        self.servers = []
        self.save_config()
    
    def get_groups(self):
        groups = set(s.group for s in self.servers)
        return sorted(groups)
    
    def get_servers_by_group(self, group):
        return [s for s in self.servers if s.group == group]
    
    def import_from_file(self, filename):
        count = 0
        existing_names = {s.name for s in self.servers}
        with open(filename, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                parts = [p.strip() for p in line.split(',')]
                if len(parts) >= 5:
                    name, host, port, username, password = parts[:5]
                    group = parts[5] if len(parts) > 5 else "Imported"
                    if name in existing_names:
                        continue  # Skip duplicates
                    existing_names.add(name)
                    server = ServerConfig(name, host, int(port), username, password, group)
                    self.add_server(server)
                    count += 1
        return count


# ==================== 连接测试线程 ====================

class ConnectionTestSignals(QObject):
    result = pyqtSignal(str, bool, str)  # server_name, success, message
    finished = pyqtSignal()


class ConnectionTestThread(QThread):
    """批量连接测试线程"""
    
    def __init__(self, servers):
        super().__init__()
        self.servers = servers
        self.signals = ConnectionTestSignals()
    
    def run(self):
        for server in self.servers:
            # 测试 Ping
            ping_ok = self.test_ping(server.host)
            
            # 测试 SSH 连接
            ssh_ok, msg = self.test_ssh(server)
            
            # 发送结果
            if ping_ok and ssh_ok:
                self.signals.result.emit(server.name, True, "✓ OK")
            elif not ping_ok:
                self.signals.result.emit(server.name, False, "✗ Ping failed")
            else:
                self.signals.result.emit(server.name, False, f"✗ {msg}")
        
        self.signals.finished.emit()
    
    def test_ping(self, host, timeout=2):
        """测试 Ping 连通性"""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            result = sock.connect_ex((host, 22))
            sock.close()
            return result == 0
        except Exception as e:
            logger.debug(f"Ping failed for {host}: {e}")
            return False
    
    def test_ssh(self, server):
        """测试 SSH 连接"""
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            client.connect(
                hostname=server.host,
                port=server.port,
                username=server.username,
                password=server.password,
                timeout=5,
                allow_agent=False,
                look_for_keys=False
            )
            
            client.close()
            return True, "Success"
            
        except paramiko.AuthenticationException:
            return False, "Auth failed"
        except Exception as e:
            return False, str(e)[:30]


# ==================== 连接测试对话框 ====================

class ConnectionTestDialog(QDialog):
    """连接测试结果对话框"""
    
    def __init__(self, servers, parent=None):
        super().__init__(parent)
        self.servers = servers
        self.setWindowTitle("⚡ CONNECTION TEST")
        self.resize(700, 500)
        
        self.setStyleSheet("""
            QDialog {
                background-color: #0a0e27;
                border: 3px solid #00d4ff;
            }
            QLabel {
                color: #00d4ff;
                font-weight: bold;
            }
            QTextEdit {
                background-color: #1a1f3a;
                color: #00ff9f;
                border: 2px solid #00d4ff;
                border-radius: 5px;
                padding: 10px;
                font-family: Consolas;
                font-size: 10pt;
            }
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                border: 2px solid #00d4ff;
                border-radius: 5px;
                color: white;
                font-weight: bold;
                padding: 10px;
                min-width: 100px;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #00d4ff, stop:1 #0099cc);
            }
        """)
        
        layout = QVBoxLayout()
        
        # 标题
        title = QLabel(f"Testing {len(servers)} servers...")
        title.setStyleSheet("font-size: 14pt;")
        layout.addWidget(title)
        
        # 结果显示区域
        self.result_text = QTextEdit()
        self.result_text.setReadOnly(True)
        layout.addWidget(self.result_text)
        
        # 统计信息
        self.stats_label = QLabel("Success: 0 | Failed: 0 | Total: 0")
        self.stats_label.setStyleSheet("color: #ff71ce; font-size: 11pt;")
        layout.addWidget(self.stats_label)
        
        # 关闭按钮
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)
        
        self.setLayout(layout)
        
        self.success_count = 0
        self.failed_count = 0
        self.total_count = 0
        
        # 启动测试
        self.start_test()
    
    def start_test(self):
        """启动测试线程"""
        self.result_text.append(">>> Starting connection test...\n")
        
        self.test_thread = ConnectionTestThread(self.servers)
        self.test_thread.signals.result.connect(self.on_test_result)
        self.test_thread.signals.finished.connect(self.on_test_finished)
        self.test_thread.start()
    
    def on_test_result(self, name, success, message):
        """处理单个测试结果"""
        self.total_count += 1
        
        if success:
            self.success_count += 1
            color = "#00ff9f"
        else:
            self.failed_count += 1
            color = "#ff2a6d"
        
        # 显示结果
        self.result_text.append(f"[{self.total_count}/{len(self.servers)}] {name}: {message}")
        
        # 更新统计
        self.stats_label.setText(
            f"Success: {self.success_count} | Failed: {self.failed_count} | Total: {self.total_count}"
        )
    
    def on_test_finished(self):
        """测试完成"""
        self.result_text.append(f"\n>>> Test completed!")
        self.result_text.append(f">>> Success rate: {self.success_count}/{len(self.servers)}")


# ==================== SSH 会话（增强版 - 带 Keepalive）====================

class SSHSessionSignals(QObject):
    output_received = pyqtSignal(bytes)
    connection_closed = pyqtSignal()
    connected = pyqtSignal()


class SSHSession:
    def __init__(self, server_config):
        self.server = server_config
        self.client = None
        self.channel = None
        self.running = False
        self.signals = SSHSessionSignals()
        # 输出环形缓冲区（供 API 读取）— 用 deque 高效限长
        self.output_buffer = deque(maxlen=500)
        self.output_lock = threading.Lock()
    
    def connect(self):
        try:
            logger.info(f"Connecting to {self.server.name} ({self.server.host}:{self.server.port})")
            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            self.client.connect(
                hostname=self.server.host,
                port=self.server.port,
                username=self.server.username,
                password=self.server.password,
                timeout=10,
                allow_agent=False,
                look_for_keys=False,
                banner_timeout=200
            )

            # TCP keepalive（传输层保活，足够可靠，不需要应用层 keepalive）
            transport = self.client.get_transport()
            if transport:
                transport.set_keepalive(15)
                sock = transport.sock
                if sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                    try:
                        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 15)
                        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
                        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 6)
                    except OSError:
                        pass  # Windows 不支持这些选项

            self.channel = self.client.invoke_shell(term='vt100', width=120, height=30)
            self.channel.setblocking(0)
            self.running = True

            threading.Thread(target=self._read_output, daemon=True).start()

            logger.info(f"Connected to {self.server.name}")
            self.signals.connected.emit()
            return True

        except Exception as e:
            logger.error(f"Connection failed to {self.server.name}: {e}")
            error = f"Connection failed: {str(e)}\n".encode('utf-8')
            self.signals.output_received.emit(error)
            return False
    
    def _read_output(self):
        """非阻塞轮询读取 SSH 输出（50ms 间隔，比原来 5ms 降低 10 倍 CPU）"""
        while self.running and self.channel:
            try:
                if self.channel.recv_ready():
                    data = self.channel.recv(8192)
                    if len(data) == 0:
                        break
                    self.signals.output_received.emit(data)
                    # 写入缓冲区供 API 读取
                    try:
                        text = data.decode('utf-8', errors='ignore')
                        with self.output_lock:
                            self.output_buffer.append(text)
                    except Exception as e:
                        logger.debug(f"Output buffer error on {self.server.name}: {e}")

                if self.channel.exit_status_ready():
                    break

                time.sleep(0.05)  # 50ms 轮询（原来 5ms，降低 10 倍 CPU）

            except Exception as e:
                logger.warning(f"Read error on {self.server.name}: {e}")
                break

        self.running = False
        logger.info(f"Session closed: {self.server.name}")
        self.signals.connection_closed.emit()

    def get_recent_output(self, lines=50):
        """获取最近的输出内容（供 API 使用）"""
        with self.output_lock:
            all_text = ''.join(self.output_buffer)
            output_lines = all_text.split('\n')
            return '\n'.join(output_lines[-lines:])

    def clear_output_buffer(self):
        """清空输出缓冲区"""
        with self.output_lock:
            self.output_buffer.clear()
    
    def send(self, data):
        if self.channel and self.running:
            try:
                if isinstance(data, str):
                    data = data.encode('utf-8')
                self.channel.send(data)
            except Exception as e:
                logger.warning(f"Send error on {self.server.name}: {e}")

    def close(self):
        self.running = False
        logger.info(f"Closing session: {self.server.name}")
        if self.channel:
            try:
                self.channel.close()
            except Exception:
                pass
        if self.client:
            try:
                self.client.close()
            except Exception:
                pass


# ==================== ANSI 解析器 ====================

class ANSIParser:
    def parse(self, text):
        text = re.sub(r'\x1b\[\?[0-9;]*[a-zA-Z]', '', text)
        text = re.sub(r'\x1b\][0-9];[^\x07]*\x07', '', text)
        text = re.sub(r'\x1b\([AB0]', '', text)
        text = re.sub(r'\x1b\[\d*[ABCDEFGJKST]', '', text)
        text = re.sub(r'\x1b\[\d*;\d*[Hf]', '', text)
        text = re.sub(r'\x1b\[K', '', text)
        text = re.sub(r'\x1b\[J', '', text)
        text = re.sub(r'\x1b\[[0-9;]*m', '', text)
        text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)
        return text


# ==================== 终端控件（添加粘贴功能）====================

class CyberpunkTerminal(QTextEdit):
    key_pressed = pyqtSignal(str)
    
    def __init__(self, parent=None):
        super().__init__(parent)
        
        self.setStyleSheet("""
            QTextEdit {
                background-color: #0a0e27;
                color: #00ff9f;
                border: 2px solid #00d4ff;
                border-radius: 8px;
                padding: 15px;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 11pt;
                selection-background-color: #ff2a6d;
            }
        """)
        
        font = QFont("Consolas", 11)
        font.setStyleHint(QFont.Monospace)
        self.setFont(font)
        
        self.setReadOnly(True)
        self.setLineWrapMode(QTextEdit.NoWrap)
        
        self.ansi_parser = ANSIParser()
        
        # 启用右键菜单
        self.setContextMenuPolicy(Qt.CustomContextMenu)
        self.customContextMenuRequested.connect(self.show_context_menu)
        
        self.installEventFilter(self)
    
    def show_context_menu(self, pos):
        """显示右键菜单"""
        from PyQt5.QtWidgets import QMenu, QAction
        
        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background-color: #1a1f3a;
                border: 2px solid #00d4ff;
                color: #00ff9f;
                padding: 5px;
            }
            QMenu::item {
                padding: 8px 20px;
            }
            QMenu::item:selected {
                background-color: #ff2a6d;
                color: white;
            }
        """)
        
        # 复制动作
        copy_action = QAction("📋 Copy", self)
        copy_action.triggered.connect(self.copy_selection)
        menu.addAction(copy_action)
        
        # 粘贴动作
        paste_action = QAction("📄 Paste", self)
        paste_action.triggered.connect(self.paste_from_clipboard)
        menu.addAction(paste_action)
        
        menu.addSeparator()
        
        # 全选动作
        select_all_action = QAction("🔘 Select All", self)
        select_all_action.triggered.connect(self.selectAll)
        menu.addAction(select_all_action)
        
        # 清屏动作
        clear_action = QAction("🗑️ Clear", self)
        clear_action.triggered.connect(self.clear)
        menu.addAction(clear_action)
        
        menu.exec_(self.mapToGlobal(pos))
    
    def copy_selection(self):
        """复制选中文本"""
        self.copy()
    
    def paste_from_clipboard(self):
        """从剪贴板粘贴"""
        from PyQt5.QtWidgets import QApplication
        clipboard = QApplication.clipboard()
        text = clipboard.text()
        if text:
            # 发送粘贴的文本
            self.key_pressed.emit(text)
    
    def eventFilter(self, obj, event):
        if obj == self and event.type() == QEvent.KeyPress:
            self.handle_key_press(event)
            return True
        return super().eventFilter(obj, event)
    
    def handle_key_press(self, event: QKeyEvent):
        key = event.key()
        text = event.text()
        modifiers = event.modifiers()
        
        special_keys = {
            Qt.Key_Backspace: b'\x7f',
            Qt.Key_Tab: b'\t',
            Qt.Key_Return: b'\r',
            Qt.Key_Enter: b'\r',
            Qt.Key_Escape: b'\x1b',
            Qt.Key_Delete: b'\x1b[3~',
            Qt.Key_Home: b'\x1b[H',
            Qt.Key_End: b'\x1b[F',
            Qt.Key_PageUp: b'\x1b[5~',
            Qt.Key_PageDown: b'\x1b[6~',
            Qt.Key_Up: b'\x1b[A',
            Qt.Key_Down: b'\x1b[B',
            Qt.Key_Right: b'\x1b[C',
            Qt.Key_Left: b'\x1b[D',
        }
        
        # Ctrl 组合键
        if modifiers & Qt.ControlModifier:
            if key == Qt.Key_C:
                # 检查是否有选中文本
                if self.textCursor().hasSelection():
                    # 有选中文本 → 复制
                    self.copy()
                else:
                    # 无选中文本 → 发送 Ctrl+C 信号
                    self.key_pressed.emit('\x03')
            elif key == Qt.Key_V:
                # Ctrl+V → 粘贴
                self.paste_from_clipboard()
            elif key == Qt.Key_D:
                self.key_pressed.emit('\x04')
            elif key == Qt.Key_Z:
                self.key_pressed.emit('\x1a')
            elif key == Qt.Key_L:
                self.key_pressed.emit('\x0c')
            elif key == Qt.Key_A:
                # Ctrl+A 有选中文本时全选，否则发送 Ctrl+A
                if self.textCursor().hasSelection():
                    self.selectAll()
                else:
                    self.key_pressed.emit('\x01')
            elif Qt.Key_A <= key <= Qt.Key_Z:
                char = chr(key - Qt.Key_A + 1)
                self.key_pressed.emit(char)
            return
        
        # Shift 组合键（用于选择文本）
        if modifiers & Qt.ShiftModifier:
            # 允许 Shift+方向键选择文本
            if key in [Qt.Key_Left, Qt.Key_Right, Qt.Key_Up, Qt.Key_Down, 
                      Qt.Key_Home, Qt.Key_End]:
                # 使用默认行为（文本选择）
                super().keyPressEvent(event)
                return
        
        # Alt 组合键
        if modifiers & Qt.AltModifier:
            if text:
                self.key_pressed.emit('\x1b' + text)
            return
        
        # 特殊按键
        if key in special_keys:
            self.key_pressed.emit(special_keys[key].decode('latin1'))
        # 普通字符
        elif text:
            self.key_pressed.emit(text)
    
    def append_data(self, data):
        try:
            text = data.decode('utf-8', errors='ignore')
        except Exception:
            return

        clean_text = self.ansi_parser.parse(text)

        # 处理退格：\x08 \x08 模式（退格-空格-退格）用于擦除字符
        # 先去掉 \r（\r\n → \n），再处理退格
        clean_text = clean_text.replace('\r\n', '\n').replace('\r', '')

        self.setReadOnly(False)
        cursor = self.textCursor()
        cursor.movePosition(QTextCursor.End)

        # 如果包含退格符，分段处理；否则直接插入
        if '\x08' in clean_text or '\x7f' in clean_text:
            i = 0
            segment = []
            while i < len(clean_text):
                ch = clean_text[i]
                if ch in ('\x08', '\x7f'):
                    if segment:
                        cursor.insertText(''.join(segment))
                        segment.clear()
                    cursor.deletePreviousChar()
                else:
                    segment.append(ch)
                i += 1
            if segment:
                cursor.insertText(''.join(segment))
        else:
            cursor.insertText(clean_text)

        self.setTextCursor(cursor)
        self.ensureCursorVisible()
        self.setReadOnly(True)

        # 限制最大字符数，防止内存无限增长（保留最近 100K 字符）
        max_chars = 100000
        doc = self.document()
        if doc.characterCount() > max_chars:
            self.setReadOnly(False)
            c = self.textCursor()
            c.movePosition(QTextCursor.Start)
            c.movePosition(QTextCursor.Right, QTextCursor.KeepAnchor, doc.characterCount() - max_chars)
            c.removeSelectedText()
            self.setReadOnly(True)
    
    def clear_screen(self):
        self.clear()

# ==================== SSH 标签页 ====================

class SSHTab(QWidget):
    title_changed = pyqtSignal(str)
    
    def __init__(self, server_config, parent=None):
        super().__init__(parent)
        self.server = server_config
        self.session = None
        
        self.init_ui()
        self.connect_server()
    
    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 5, 5)
        layout.setSpacing(5)
        
        # 信息栏
        info_bar = QHBoxLayout()
        info_label = QLabel(f"⚡ {self.server.name} | {self.server.username}@{self.server.host}:{self.server.port}")
        info_label.setStyleSheet("""
            QLabel {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                color: white;
                padding: 8px;
                border-radius: 5px;
                font-weight: bold;
                border: 1px solid #00d4ff;
            }
        """)
        info_bar.addWidget(info_label)
        layout.addLayout(info_bar)
        
        # 终端
        self.terminal = CyberpunkTerminal()
        self.terminal.key_pressed.connect(self.send_key)
        self.terminal.setFocus()
        layout.addWidget(self.terminal)
    
    def connect_server(self):
        msg = f">>> Connecting to {self.server.host}...\n".encode('utf-8')
        self.terminal.append_data(msg)
        
        self.session = SSHSession(self.server)
        self.session.signals.output_received.connect(self.terminal.append_data)
        self.session.signals.connection_closed.connect(self.on_closed)
        self.session.signals.connected.connect(self.on_connected)
        
        threading.Thread(target=self.session.connect, daemon=True).start()
    
    def on_connected(self):
        self.title_changed.emit(f"✓ {self.server.name}")
        self.terminal.setFocus()
    
    def on_closed(self):
        self.terminal.append_data(b"\n>>> [Connection closed] <<<\n")
        self.title_changed.emit(f"✗ {self.server.name}")
    
    def send_key(self, key):
        if self.session and self.session.running:
            self.session.send(key)
    
    def send_command(self, command):
        """从外部发送命令（用于广播 / API）"""
        if self.session and self.session.running:
            self.session.send(command)
            logger.debug(f"CMD [{self.server.name}]: {command.strip()[:80]}")
    
    def close_session(self):
        if self.session:
            self.session.close()


# ==================== 服务器树 ====================

class CyberpunkTreeWidget(QTreeWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        
        self.setHeaderLabel("⚡ SERVERS")
        self.setStyleSheet("""
            QTreeWidget {
                background-color: #0a0e27;
                color: #00d4ff;
                border: 2px solid #ff2a6d;
                border-radius: 8px;
                font-size: 11pt;
                font-weight: bold;
                padding: 8px;
            }
            QTreeWidget::item {
                padding: 10px;
                border-radius: 5px;
            }
            QTreeWidget::item:hover {
                background-color: #1a1f3a;
                border-left: 3px solid #00ff9f;
            }
            QTreeWidget::item:selected {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                color: white;
            }
            QHeaderView::section {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                color: white;
                padding: 10px;
                border: none;
                font-weight: bold;
            }
        """)


# ==================== 对话框 ====================

class CyberpunkDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("⚡ ADD SERVER")
        self.resize(450, 350)
        
        self.setStyleSheet("""
            QDialog {
                background-color: #0a0e27;
                border: 3px solid #00d4ff;
                border-radius: 10px;
            }
            QLabel {
                color: #00d4ff;
                font-weight: bold;
                font-size: 11pt;
            }
            QLineEdit {
                background-color: #1a1f3a;
                border: 2px solid #00d4ff;
                border-radius: 5px;
                padding: 10px;
                color: #00ff9f;
                font-size: 11pt;
                font-weight: bold;
            }
            QLineEdit:focus {
                border: 2px solid #ff2a6d;
            }
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                border: 2px solid #00d4ff;
                border-radius: 8px;
                color: white;
                font-weight: bold;
                padding: 12px;
                min-width: 100px;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #00d4ff, stop:1 #0099cc);
            }
        """)
        
        layout = QFormLayout()
        
        self.name_input = QLineEdit()
        self.host_input = QLineEdit()
        self.port_input = QLineEdit("22")
        self.username_input = QLineEdit()
        self.password_input = QLineEdit()
        self.password_input.setEchoMode(QLineEdit.Password)
        self.group_input = QLineEdit("Default")
        
        layout.addRow("Name:", self.name_input)
        layout.addRow("Host:", self.host_input)
        layout.addRow("Port:", self.port_input)
        layout.addRow("User:", self.username_input)
        layout.addRow("Pass:", self.password_input)
        layout.addRow("Group:", self.group_input)
        
        btn_layout = QHBoxLayout()
        save_btn = QPushButton("✓ SAVE")
        cancel_btn = QPushButton("✗ CANCEL")
        save_btn.clicked.connect(self.accept)
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(save_btn)
        btn_layout.addWidget(cancel_btn)
        
        main_layout = QVBoxLayout()
        main_layout.addLayout(layout)
        main_layout.addLayout(btn_layout)
        self.setLayout(main_layout)
    
    def get_server_config(self):
        return ServerConfig(
            name=self.name_input.text().strip(),
            host=self.host_input.text().strip(),
            port=int(self.port_input.text().strip()),
            username=self.username_input.text().strip(),
            password=self.password_input.text(),
            group=self.group_input.text().strip() or "Default"
        )


# ==================== API 信号桥（线程安全）====================

class APIBridge(QObject):
    """
    信号桥：HTTP API 线程通过此对象发信号到主线程执行 Qt 操作。
    解决 PyQt5 跨线程操作 GUI 控件导致卡死/崩溃的问题。
    """
    # 信号定义
    sig_open_servers = pyqtSignal(str, str)  # filter, group
    sig_close_server = pyqtSignal(str)       # server_name
    sig_import_file = pyqtSignal(str)        # file_path
    sig_refresh_tree = pyqtSignal()
    sig_get_sessions = pyqtSignal()          # 获取会话列表
    sig_find_tabs = pyqtSignal(str)          # 查找匹配的 tabs
    sig_send_command = pyqtSignal(str, str)  # server_name, command

    def __init__(self, main_window):
        super().__init__()
        self.win = main_window
        self.sig_open_servers.connect(self._do_open_servers, Qt.QueuedConnection)
        self.sig_close_server.connect(self._do_close_server, Qt.QueuedConnection)
        self.sig_import_file.connect(self._do_import_file, Qt.QueuedConnection)
        self.sig_refresh_tree.connect(self.win.refresh_server_tree, Qt.QueuedConnection)
        self.sig_get_sessions.connect(self._do_get_sessions, Qt.QueuedConnection)
        self.sig_find_tabs.connect(self._do_find_tabs, Qt.QueuedConnection)
        self.sig_send_command.connect(self._do_send_command, Qt.QueuedConnection)
        # 用于返回结果给 API 线程
        self._result = None
        self._event = threading.Event()

    def _do_open_servers(self, filter_str, group):
        """在主线程打开匹配的服务器"""
        opened = []
        for s in self.win.manager.servers:
            match = False
            if filter_str and filter_str.upper() in s.name.upper():
                match = True
            if group and s.group == group:
                match = True
            if match:
                already = any(
                    isinstance(self.win.tab_widget.widget(i), SSHTab)
                    and self.win.tab_widget.widget(i).server.name == s.name
                    for i in range(self.win.tab_widget.count())
                )
                if not already:
                    self.win.open_ssh_tab(s)
                    opened.append(s.name)
        logger.info(f"API /open: opened {len(opened)} sessions")
        self._result = opened
        self._event.set()

    def _do_close_server(self, server_name):
        """在主线程关闭会话"""
        closed = False
        for i in range(self.win.tab_widget.count()):
            tab = self.win.tab_widget.widget(i)
            if isinstance(tab, SSHTab) and (
                tab.server.name == server_name or server_name in tab.server.name
            ):
                tab.close_session()
                self.win.tab_widget.removeTab(i)
                closed = True
                logger.info(f"API /close: closed {server_name}")
                break
        self._result = closed
        self._event.set()

    def _do_import_file(self, file_path):
        """在主线程导入服务器"""
        try:
            count = self.win.manager.import_from_file(file_path)
            self.win.refresh_server_tree()
            logger.info(f"API /import: imported {count} servers from {file_path}")
            self._result = {'ok': True, 'imported': count}
        except Exception as e:
            logger.error(f"API /import error: {e}")
            self._result = {'error': str(e)}
        self._event.set()

    def request_open(self, filter_str='', group=''):
        self._event.clear()
        self.sig_open_servers.emit(filter_str, group)
        self._event.wait(timeout=10)
        return self._result

    def request_close(self, server_name):
        self._event.clear()
        self.sig_close_server.emit(server_name)
        self._event.wait(timeout=5)
        return self._result

    def request_import(self, file_path):
        self._event.clear()
        self.sig_import_file.emit(file_path)
        self._event.wait(timeout=10)
        return self._result

    def _do_get_sessions(self):
        """在主线程读取会话列表"""
        sessions = []
        try:
            count = self.win.tab_widget.count()
            logger.debug(f"_do_get_sessions: tab_widget has {count} tabs")
            for i in range(count):
                tab = self.win.tab_widget.widget(i)
                logger.debug(f"  tab[{i}]: type={type(tab).__name__}, is_SSHTab={isinstance(tab, SSHTab)}")
                if isinstance(tab, SSHTab):
                    connected = tab.session and tab.session.running
                    sessions.append({
                        'index': i,
                        'name': tab.server.name,
                        'host': tab.server.host,
                        'port': tab.server.port,
                        'username': tab.server.username,
                        'group': tab.server.group,
                        'connected': connected,
                    })
        except Exception as e:
            logger.error(f"get_sessions error: {e}")
        logger.debug(f"_do_get_sessions: returning {len(sessions)} sessions")
        self._result = sessions
        self._event.set()

    def get_sessions(self):
        """线程安全：通过信号在主线程获取会话列表"""
        logger.debug("get_sessions: emitting sig_get_sessions")
        self._event.clear()
        self.sig_get_sessions.emit()
        waited = self._event.wait(timeout=5)
        logger.debug(f"get_sessions: wait returned {waited}, result has {len(self._result) if self._result else 0} items")
        return self._result or []

    def _do_find_tabs(self, filter_str):
        """在主线程查找匹配的 tabs 并返回信息"""
        tabs_info = []
        try:
            for i in range(self.win.tab_widget.count()):
                tab = self.win.tab_widget.widget(i)
                if isinstance(tab, SSHTab) and tab.session and tab.session.running:
                    if not filter_str or filter_str.upper() in tab.server.name.upper():
                        tabs_info.append({
                            'index': i,
                            'name': tab.server.name,
                            'tab': tab,
                        })
        except Exception as e:
            logger.error(f"find_tabs error: {e}")
        self._result = tabs_info
        self._event.set()

    def find_tabs(self, filter_str=''):
        """线程安全：通过信号在主线程查找 tabs"""
        self._event.clear()
        self.sig_find_tabs.emit(filter_str)
        self._event.wait(timeout=5)
        return self._result or []

    def _do_send_command(self, server_name, command):
        """在主线程发送命令到指定会话"""
        sent = False
        try:
            for i in range(self.win.tab_widget.count()):
                tab = self.win.tab_widget.widget(i)
                if isinstance(tab, SSHTab) and (
                    tab.server.name == server_name or server_name in tab.server.name
                ):
                    if tab.session and tab.session.running:
                        tab.send_command(command)
                        sent = True
                        break
        except Exception as e:
            logger.error(f"send_command error: {e}")
        self._result = sent
        self._event.set()

    def request_send_command(self, server_name, command):
        """线程安全：通过信号在主线程发送命令"""
        self._event.clear()
        self.sig_send_command.emit(server_name, command)
        self._event.wait(timeout=5)
        return self._result

    def find_tab(self, server_name):
        """线程安全：通过 find_tabs 查找单个 tab"""
        tabs = self.find_tabs('')
        for t in tabs:
            if t['name'] == server_name or server_name in t['name']:
                return t.get('tab')
        return None


# ==================== Chat Processor（调用 claude -p）====================

class ChatProcessor:
    """调用 claude -p 处理自然语言指令"""
    is_busy = False
    history = []  # [{role, content, timestamp}]
    prompt_file = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'chat_agent_prompt.md')
    git_bash = None  # 缓存 git bash 路径

    # Claude CLI 路径（优先环境变量，否则自动查找）
    claude_cmd_path = os.environ.get('CLAUDE_CMD_PATH', '')

    @classmethod
    def _find_claude_cmd(cls):
        if cls.claude_cmd_path and os.path.exists(cls.claude_cmd_path):
            return cls.claude_cmd_path
        # 自动查找 npm 全局安装的 claude.cmd
        npm_prefix = os.path.join(os.environ.get('APPDATA', ''), 'npm')
        candidate = os.path.join(npm_prefix, 'claude.cmd')
        if os.path.exists(candidate):
            cls.claude_cmd_path = candidate
            return candidate
        return None

    @classmethod
    def _find_git_bash(cls):
        if cls.git_bash:
            return cls.git_bash
        candidates = [
            r'D:\Program Files\Git\bin\bash.exe',
            r'C:\Program Files\Git\bin\bash.exe',
            r'C:\Program Files (x86)\Git\bin\bash.exe',
        ]
        for p in candidates:
            if os.path.exists(p):
                cls.git_bash = p
                return p
        return None

    @classmethod
    def process(cls, message, timeout=120):
        cls.is_busy = True
        ts = time.strftime('%H:%M:%S')
        cls.history.append({'role': 'user', 'content': message, 'timestamp': ts})
        logger.info(f"Chat processing: {message[:100]}")

        try:
            # 构建 claude -p 命令
            git_bash = cls._find_git_bash()
            if not git_bash:
                return '❌ 找不到 Git Bash，无法调用 Claude CLI'

            # 读取系统提示
            system_prompt = ''
            if os.path.exists(cls.prompt_file):
                with open(cls.prompt_file, 'r', encoding='utf-8') as f:
                    system_prompt = f.read()

            # 构建完整提示 — 动态注入凭据
            auth_user = XShellAPIHandler.auth_user
            auth_pass = XShellAPIHandler.auth_pass
            auth = f"{auth_user}:{auth_pass}"
            full_prompt = (
                f"Execute this task NOW using bash curl commands. Do not ask questions, just do it.\n\n"
                f"RemoteX API at http://127.0.0.1:9876 with auth: -u {auth}\n\n"
                f"IMPORTANT WORKFLOW: If no sessions are open, you MUST first call /open to open connections, then use /exec_wait.\n\n"
                f"API Reference:\n"
                f"# List all configured servers (always available, no session needed)\n"
                f"curl -s -u {auth} http://127.0.0.1:9876/servers\n\n"
                f"# List active sessions\n"
                f"curl -s -u {auth} http://127.0.0.1:9876/sessions\n\n"
                f"# OPEN connections (MUST do this first if no sessions exist!)\n"
                f"curl -s -u {auth} -X POST http://127.0.0.1:9876/open -H 'Content-Type: application/json' -d '{{\"filter\":\"KEYWORD\"}}'\n\n"
                f"# Run command on one server (requires active session)\n"
                f"curl -s -u {auth} -X POST http://127.0.0.1:9876/exec_wait -H 'Content-Type: application/json' -d '{{\"server\":\"NAME\",\"command\":\"CMD\",\"wait\":3}}'\n\n"
                f"# Run command on all/filtered servers (requires active sessions)\n"
                f"curl -s -u {auth} -X POST http://127.0.0.1:9876/exec_all -H 'Content-Type: application/json' -d '{{\"command\":\"CMD\",\"filter\":\"KEYWORD\",\"wait\":3}}'\n\n"
                f"# Close a session\n"
                f"curl -s -u {auth} -X POST http://127.0.0.1:9876/close -H 'Content-Type: application/json' -d '{{\"server\":\"NAME\"}}'\n\n"
                f"Rules: You can execute ANY command. User has full authority.\n"
                f"For destructive ops (rm -rf, reboot), confirm target in reply.\n"
                f"Reply in Chinese. Keep it short for mobile.\n\n"
                f"USER REQUEST: {message}\n\n"
                f"CRITICAL STEPS (you MUST follow ALL steps):\n"
                f"1) First call /sessions to check active sessions.\n"
                f"2) If count is 0 or the target server is not in the list, you MUST call /open with filter to open it. Example: curl -s -u {auth} -X POST http://127.0.0.1:9876/open -H 'Content-Type: application/json' -d '{{\"filter\":\"SEDU\"}}'\n"
                f"3) Wait 2 seconds: sleep 2\n"
                f"4) Then call /exec_wait to run the command.\n"
                f"NEVER say 'no sessions' without first trying /open. ALWAYS try /open before giving up."
            )

            env = os.environ.copy()
            env['CLAUDE_CODE_GIT_BASH_PATH'] = git_bash
            # 也设置 Windows 原生路径格式
            env['CLAUDE_CODE_GIT_BASH_PATH'] = git_bash.replace('/', '\\')

            # 写 prompt 到临时文件避免 shell 转义和长度问题
            import tempfile
            prompt_tmp = os.path.join(tempfile.gettempdir(), 'termix_chat_prompt.txt')
            with open(prompt_tmp, 'w', encoding='utf-8') as f:
                f.write(full_prompt)

            # 写 prompt 到临时文件
            import tempfile
            prompt_file = os.path.join(tempfile.gettempdir(), 'termix_chat_prompt.txt')
            with open(prompt_file, 'w', encoding='utf-8') as pf:
                pf.write(full_prompt)

            logger.debug(f"Chat calling claude -p, prompt len: {len(full_prompt)}")

            # Windows 路径转 Git Bash 兼容格式
            git_bash_unix = git_bash.replace('\\', '/')
            if git_bash_unix[1] == ':':
                git_bash_unix = '/' + git_bash_unix[0].lower() + git_bash_unix[2:]
            claude_unix = cls.claude_cmd_path.replace('\\', '/')
            if claude_unix[1] == ':':
                claude_unix = '/' + claude_unix[0].lower() + claude_unix[2:]
            prompt_unix = prompt_file.replace('\\', '/')
            if prompt_unix[1] == ':':
                prompt_unix = '/' + prompt_unix[0].lower() + prompt_unix[2:]

            # 写 prompt 到文件，用 git bash 读取并传给 claude
            import tempfile
            prompt_file = os.path.join(tempfile.gettempdir(), 'termix_chat.txt')
            with open(prompt_file, 'w', encoding='utf-8') as pf:
                pf.write(full_prompt)
            prompt_unix = prompt_file.replace('\\', '/')
            if prompt_unix[1] == ':':
                prompt_unix = '/' + prompt_unix[0].lower() + prompt_unix[2:]

            # 用 git bash 执行（用 claude 而不是 claude.cmd）
            # git bash 的 npm shim 会处理 .cmd 转发
            npm_path = os.path.join(os.environ.get('APPDATA', ''), 'npm').replace('\\', '/')
            if npm_path[1] == ':':
                npm_path = '/' + npm_path[0].lower() + npm_path[2:]
            bash_script = f'''#!/bin/bash
export CLAUDE_CODE_GIT_BASH_PATH='{git_bash}'
export PATH="{npm_path}:$PATH"
PROMPT=$(cat '{prompt_unix}')
claude -p "$PROMPT" --allowedTools Bash
'''
            script_file = os.path.join(tempfile.gettempdir(), 'termix_chat.sh')
            with open(script_file, 'w', encoding='utf-8', newline='\n') as sf:
                sf.write(bash_script)

            # 在 temp 目录运行，避免项目 CLAUDE.md 干扰 chat agent
            # 输出重定向到文件（绕过 PyQt5 的 stdout 劫持）
            import tempfile
            out_file = os.path.join(tempfile.gettempdir(), 'termix_chat_out.txt')
            err_file = os.path.join(tempfile.gettempdir(), 'termix_chat_err.txt')
            out_unix = out_file.replace('\\', '/')
            if out_unix[1] == ':':
                out_unix = '/' + out_unix[0].lower() + out_unix[2:]

            # 在脚本末尾重定向输出到文件
            with open(script_file, 'a', encoding='utf-8', newline='\n') as sf:
                pass  # script already written above

            # 用 wrapper 脚本把输出写到文件
            wrapper = os.path.join(tempfile.gettempdir(), 'termix_chat_run.sh')
            with open(wrapper, 'w', encoding='utf-8', newline='\n') as wf:
                wf.write(f'#!/bin/bash\nbash "{script_file.replace(os.sep, "/")}" > "{out_unix}" 2>&1\n')

            proc = subprocess.run(
                [git_bash, wrapper],
                timeout=timeout, env=env, cwd=tempfile.gettempdir()
            )

            # 读取输出文件
            reply_text = ''
            if os.path.exists(out_file):
                with open(out_file, 'r', encoding='utf-8', errors='replace') as of:
                    reply_text = of.read().strip()
            result = type('R', (), {'stdout': reply_text, 'stderr': '', 'returncode': proc.returncode})()

            reply = (result.stdout or '').strip()
            if not reply and result.stderr:
                reply = f'❌ Error: {(result.stderr or "")[:200]}'
            if not reply:
                reply = '❌ 未收到回复'
            logger.debug(f"Chat subprocess: code={result.returncode}, stdout={len(result.stdout or '')} chars, stderr={len(result.stderr or '')} chars")

            # 截断过长回复（手机友好）
            if len(reply) > 2000:
                reply = reply[:1900] + '\n\n... (输出过长已截断)'

            logger.info(f"Chat reply: {reply[:100]}")
            cls.history.append({'role': 'assistant', 'content': reply, 'timestamp': time.strftime('%H:%M:%S')})
            return reply

        except subprocess.TimeoutExpired:
            reply = '⏰ 执行超时（超过120秒），请简化指令重试'
            cls.history.append({'role': 'assistant', 'content': reply, 'timestamp': time.strftime('%H:%M:%S')})
            return reply
        except Exception as e:
            reply = f'❌ 调用失败: {str(e)}'
            cls.history.append({'role': 'assistant', 'content': reply, 'timestamp': time.strftime('%H:%M:%S')})
            logger.error(f"Chat error: {e}")
            return reply
        finally:
            cls.is_busy = False


# ==================== HTTP API 服务器（供 Claude Code 控制）====================

class XShellAPIHandler(BaseHTTPRequestHandler):
    """轻量 HTTP API，让 Claude Code 通过 curl 控制 RemoteX 会话"""

    bridge = None  # APIBridge instance, set after init
    auth_user = 'admin'
    auth_pass = '88888888'

    def _check_auth(self):
        """验证 Basic Auth，未通过返回 False 并发送 401"""
        import base64
        auth_header = self.headers.get('Authorization', '')
        if not auth_header.startswith('Basic '):
            self._send_401()
            return False
        try:
            decoded = base64.b64decode(auth_header[6:]).decode('utf-8')
            user, pwd = decoded.split(':', 1)
            if user == self.auth_user and pwd == self.auth_pass:
                return True
        except Exception:
            pass
        self._send_401()
        return False

    def _send_401(self):
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="RemoteX"')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error":"Unauthorized"}')

    def log_message(self, format, *args):
        # 记录到日志文件而不是 stderr
        logger.debug(f"API {args[0] if args else ''}")

    def _set_headers(self, code=200, content_type='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        # 尝试多种编码
        for encoding in ['utf-8', 'gbk', 'latin-1']:
            try:
                return json.loads(raw.decode(encoding))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        logger.warning(f"API: malformed JSON body, raw={raw[:100]}")
        return {}

    def _respond(self, data, code=200):
        self._set_headers(code)
        self.wfile.write(json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # /terminal 页面不需要认证（认证在页面内 JS 层完成）
        if path == '/terminal':
            _script_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
            terminal_file = os.path.join(_script_dir, 'RemoteX', 'public', 'terminal.html')
            if os.path.exists(terminal_file):
                self._set_headers(200, 'text/html; charset=utf-8')
                with open(terminal_file, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self._respond({'error': 'terminal.html not found'}, 404)
            return

        if not self._check_auth():
            return
        params = parse_qs(parsed.query)
        bridge = XShellAPIHandler.bridge

        if path == '/sessions':
            logger.debug(f"/sessions handler: bridge={bridge}, type={type(bridge)}")
            sessions = bridge.get_sessions() if bridge else []
            logger.debug(f"/sessions handler: got {len(sessions)} sessions")
            self._respond({'sessions': sessions, 'count': len(sessions)})

        elif path == '/' or path == '/status':
            # 返回状态页面
            _script_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
            status_file = os.path.join(_script_dir, 'RemoteX', 'public', 'status.html')
            if os.path.exists(status_file):
                self._set_headers(200, 'text/html; charset=utf-8')
                with open(status_file, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self._respond({'error': 'status.html not found'}, 404)

        elif path == '/servers':
            servers = [s.to_dict() for s in bridge.win.manager.servers] if bridge else []
            self._respond({'servers': servers, 'count': len(servers)})

        elif path == '/health':
            count = len(bridge.get_sessions()) if bridge else 0
            self._respond({'status': 'ok', 'sessions': count})

        elif path.startswith('/output'):
            server_name = params.get('server', [''])[0]
            lines = int(params.get('lines', ['50'])[0])
            if not server_name:
                self._respond({'error': 'Missing ?server= parameter'}, 400)
                return
            tab = bridge.find_tab(server_name) if bridge else None
            if tab and tab.session:
                output = tab.session.get_recent_output(lines)
                self._respond({'server': tab.server.name, 'lines': lines, 'output': output})
            else:
                self._respond({'error': f'Session not found: {server_name}'}, 404)

        elif path == '/output_all':
            lines = int(params.get('lines', ['20'])[0])
            results = {}
            if bridge:
                for t in bridge.find_tabs():
                    tab = t.get('tab')
                    if tab and tab.session:
                        results[t['name']] = tab.session.get_recent_output(lines)
            self._respond({'outputs': results, 'count': len(results)})

        elif path == '/exec':
            server_name = params.get('server', [''])[0]
            command = params.get('command', [''])[0]
            wait = float(params.get('wait', ['3'])[0])
            if not server_name or not command:
                self._respond({'error': 'Missing ?server= or ?command='}, 400)
                return
            tab = bridge.find_tab(server_name) if bridge else None
            if tab and tab.session and tab.session.running:
                logger.info(f"API /exec: [{tab.server.name}] {command}")
                tab.session.clear_output_buffer()
                bridge.request_send_command(server_name, command + '\n')
                time.sleep(wait)
                output = tab.session.get_recent_output(100)
                self._respond({'server': tab.server.name, 'command': command, 'output': output})
            else:
                self._respond({'error': f'Session not found: {server_name}'}, 404)

        else:
            self._respond({'error': 'GET endpoints: /sessions /servers /health /output /output_all /exec /terminal'}, 404)

    def do_POST(self):
        if not self._check_auth():
            return
        path = urlparse(self.path).path
        body = self._read_body()
        bridge = XShellAPIHandler.bridge

        if not bridge:
            self._respond({'error': 'Main window not ready'}, 503)
            return

        if path == '/send':
            server_name = body.get('server', '')
            command = body.get('command', '')
            if not command:
                self._respond({'error': 'Missing "command" field'}, 400)
                return
            sent = bridge.request_send_command(server_name, command + '\n')
            if sent:
                logger.info(f"API /send: [{server_name}] {command}")
                self._respond({'ok': True, 'server': server_name, 'command': command})
            else:
                self._respond({'error': f'Session not found: {server_name}'}, 404)

        elif path == '/broadcast':
            command = body.get('command', '')
            if not command:
                self._respond({'error': 'Missing "command" field'}, 400)
                return
            tabs = bridge.find_tabs()
            for t in tabs:
                bridge.request_send_command(t['name'], command + '\n')
            logger.info(f"API /broadcast: [{len(tabs)} sessions] {command}")
            self._respond({'ok': True, 'command': command, 'sent_to': len(tabs)})

        elif path == '/send_multi':
            pattern = body.get('filter', '')
            command = body.get('command', '')
            if not command or not pattern:
                self._respond({'error': 'Missing "filter" or "command" field'}, 400)
                return
            tabs = bridge.find_tabs(pattern)
            targets = []
            for t in tabs:
                bridge.request_send_command(t['name'], command + '\n')
                targets.append(t['name'])
            logger.info(f"API /send_multi: [{len(targets)} sessions, filter={pattern}] {command}")
            self._respond({'ok': True, 'command': command, 'sent_to': len(targets), 'targets': targets})

        elif path == '/open':
            filter_str = body.get('filter', '')
            group = body.get('group', '')
            if not filter_str and not group:
                self._respond({'error': 'Missing "filter" or "group" field'}, 400)
                return
            # 通过信号桥在主线程打开（线程安全）
            opened = bridge.request_open(filter_str, group)
            self._respond({'ok': True, 'opened': opened or [], 'count': len(opened or [])})

        elif path == '/close':
            server_name = body.get('server', '')
            if not server_name:
                self._respond({'error': 'Missing "server" field'}, 400)
                return
            # 通过信号桥在主线程关闭（线程安全）
            closed = bridge.request_close(server_name)
            self._respond({'ok': closed, 'server': server_name})

        elif path == '/exec_wait':
            server_name = body.get('server', '')
            command = body.get('command', '')
            wait = float(body.get('wait', 3))
            if not server_name or not command:
                self._respond({'error': 'Missing "server" or "command" field'}, 400)
                return
            tab = bridge.find_tab(server_name)
            if tab and tab.session and tab.session.running:
                logger.info(f"API /exec_wait: [{tab.server.name}] {command}")
                tab.session.clear_output_buffer()
                bridge.request_send_command(server_name, command + '\n')
                time.sleep(wait)
                output = tab.session.get_recent_output(100)
                self._respond({'server': tab.server.name, 'command': command, 'output': output})
            else:
                self._respond({'error': f'Session not found: {server_name}'}, 404)

        elif path == '/exec_all':
            command = body.get('command', '')
            filter_str = body.get('filter', '')
            wait = float(body.get('wait', 3))
            if not command:
                self._respond({'error': 'Missing "command" field'}, 400)
                return
            tabs = bridge.find_tabs(filter_str)
            for t in tabs:
                tab = t.get('tab')
                if tab and tab.session:
                    tab.session.clear_output_buffer()
                bridge.request_send_command(t['name'], command + '\n')
            logger.info(f"API /exec_all: [{len(tabs)} sessions] {command}")
            time.sleep(wait)
            results = {}
            for t in tabs:
                tab = t.get('tab')
                if tab and tab.session:
                    results[t['name']] = tab.session.get_recent_output(100)
            self._respond({'command': command, 'results': results, 'count': len(results)})

        elif path == '/import':
            file_path = body.get('file_path', '')
            if not file_path:
                self._respond({'error': 'Missing "file_path" field'}, 400)
                return
            # 通过信号桥在主线程导入（线程安全）
            result = bridge.request_import(file_path)
            code = 200 if result and result.get('ok') else 500
            self._respond(result or {'error': 'timeout'}, code)

        elif path == '/chat':
            message = body.get('message', '').strip()
            if not message:
                self._respond({'error': 'Missing "message" field'}, 400)
                return

            logger.info(f"API /chat: {message[:100]}")

            # 限流：如果正在处理另一个 chat 请求，拒绝
            if ChatProcessor.is_busy:
                self._respond({'error': 'busy', 'reply': '⏳ 正在处理上一条消息，请稍后再试。'}, 429)
                return

            try:
                reply = ChatProcessor.process(message)
                self._respond({'ok': True, 'message': message, 'reply': reply})
            except Exception as e:
                logger.error(f"Chat error: {e}")
                self._respond({'error': str(e), 'reply': f'❌ 处理出错: {str(e)}'}, 500)

        elif path == '/chat/history':
            self._respond({'history': ChatProcessor.history[-50:]})

        else:
            self._respond({'error': 'POST endpoints: /send /broadcast /send_multi /open /close /exec_wait /exec_all /import /chat'}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()


# ==================== WebSocket 终端服务器（手机 Web SSH）====================

class WebTerminalServer:
    """WebSocket 服务器，为每个 Web 连接创建独立 SSH shell channel"""

    bridge = None  # APIBridge instance, set after init
    auth_user = 'admin'
    auth_pass = '88888888'

    @classmethod
    async def handler(cls, websocket, path=None):
        """处理一个 WebSocket 连接的完整生命周期"""
        # 1. 验证 Basic Auth（从第一条消息或 URL 参数）
        try:
            # 等待客户端发送 auth 消息
            auth_msg = await asyncio.wait_for(websocket.recv(), timeout=10)
            auth_data = json.loads(auth_msg)

            if auth_data.get('type') != 'auth':
                await websocket.send(json.dumps({'type': 'error', 'message': 'Auth required'}))
                return

            if auth_data.get('user') != cls.auth_user or auth_data.get('pass') != cls.auth_pass:
                await websocket.send(json.dumps({'type': 'error', 'message': 'Invalid credentials'}))
                return

            await websocket.send(json.dumps({'type': 'auth_ok'}))

        except Exception as e:
            logger.warning(f"WebTerminal auth failed: {e}")
            return

        # 2. 等待客户端请求连接到某个服务器
        try:
            connect_msg = await asyncio.wait_for(websocket.recv(), timeout=30)
            connect_data = json.loads(connect_msg)

            if connect_data.get('type') != 'connect':
                await websocket.send(json.dumps({'type': 'error', 'message': 'Expected connect message'}))
                return

            server_name = connect_data.get('server', '')
            cols = connect_data.get('cols', 120)
            rows = connect_data.get('rows', 30)

        except Exception as e:
            logger.warning(f"WebTerminal connect failed: {e}")
            return

        # 3. 查找服务器配置，直接建立独立 SSH 连接（不依赖 GUI）
        if not cls.bridge:
            await websocket.send(json.dumps({'type': 'error', 'message': 'Server not ready'}))
            return

        # 从服务器配置中查找
        server_cfg = None
        for s in cls.bridge.win.manager.servers:
            if s.name == server_name or server_name in s.name:
                server_cfg = s
                break

        if not server_cfg:
            await websocket.send(json.dumps({'type': 'error', 'message': f'Server not found: {server_name}'}))
            return

        ssh_client = None
        try:
            loop = asyncio.get_event_loop()

            # 在线程中建立 SSH 连接（阻塞操作）
            def do_ssh_connect():
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                client.connect(
                    hostname=server_cfg.host,
                    port=server_cfg.port,
                    username=server_cfg.username,
                    password=server_cfg.password,
                    timeout=10,
                    allow_agent=False,
                    look_for_keys=False,
                    banner_timeout=200,
                )
                transport = client.get_transport()
                if transport:
                    transport.set_keepalive(15)
                return client

            ssh_client = await loop.run_in_executor(None, do_ssh_connect)

            transport = ssh_client.get_transport()
            channel = transport.open_session()
            channel.get_pty(term='xterm-256color', width=cols, height=rows)
            channel.invoke_shell()
            channel.setblocking(0)

            await websocket.send(json.dumps({
                'type': 'connected',
                'server': server_cfg.name,
                'host': server_cfg.host,
            }))
            logger.info(f"WebTerminal connected: {server_cfg.name} ({cols}x{rows})")

        except Exception as e:
            await websocket.send(json.dumps({'type': 'error', 'message': f'SSH connect failed: {e}'}))
            logger.error(f"WebTerminal SSH connect failed: {e}")
            if ssh_client:
                try: ssh_client.close()
                except: pass
            return

        # 4. 双向数据转发
        stop_event = asyncio.Event()

        async def ssh_to_ws():
            """SSH channel → WebSocket（推送终端输出）"""
            loop = asyncio.get_event_loop()
            try:
                while not stop_event.is_set():
                    try:
                        data = await loop.run_in_executor(None, lambda: channel.recv(4096) if channel.recv_ready() else b'')
                        if data:
                            await websocket.send(data)
                        else:
                            if channel.exit_status_ready():
                                break
                            await asyncio.sleep(0.05)
                    except Exception:
                        break
            finally:
                stop_event.set()

        async def ws_to_ssh():
            """WebSocket → SSH channel（接收键盘输入）"""
            try:
                async for message in websocket:
                    if isinstance(message, str):
                        # 可能是 JSON 控制消息
                        try:
                            data = json.loads(message)
                            if data.get('type') == 'resize':
                                channel.resize_pty(
                                    width=data.get('cols', 120),
                                    height=data.get('rows', 30)
                                )
                                continue
                            elif data.get('type') == 'input':
                                channel.send(data.get('data', '').encode('utf-8'))
                                continue
                        except json.JSONDecodeError:
                            pass
                        # 纯文本输入
                        channel.send(message.encode('utf-8'))
                    elif isinstance(message, bytes):
                        channel.send(message)
            except websockets.exceptions.ConnectionClosed:
                pass
            finally:
                stop_event.set()

        try:
            await asyncio.gather(ssh_to_ws(), ws_to_ssh())
        except Exception as e:
            logger.debug(f"WebTerminal session ended: {e}")
        finally:
            try:
                channel.close()
            except Exception:
                pass
            if ssh_client:
                try:
                    ssh_client.close()
                except Exception:
                    pass
            logger.info(f"WebTerminal disconnected: {server_name}")

    @classmethod
    def start(cls, port=9877):
        """在后台线程启动 WebSocket 服务器"""
        if not HAS_WEBSOCKETS:
            logger.warning("websockets not installed, WebTerminal disabled")
            return

        def run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            async def serve():
                async with websockets.serve(cls.handler, '0.0.0.0', port, max_size=2**20):
                    logger.info(f"WebSocket terminal server on ws://0.0.0.0:{port}")
                    await asyncio.Future()  # run forever

            loop.run_until_complete(serve())

        thread = threading.Thread(target=run, daemon=True)
        thread.start()


def start_api_server(port=9876):
    """在后台线程启动多线程 HTTP API 服务器"""
    server = ThreadingHTTPServer(('0.0.0.0', port), XShellAPIHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info(f"HTTP API server running on http://127.0.0.1:{port}")
    return server


# ==================== 主窗口 ====================

class CyberpunkSSH(QMainWindow):
    def __init__(self, args=None):
        super().__init__()

        self.setWindowTitle("⚡ RemoteX — AI SSH Fleet Manager ⚡")
        self.setGeometry(100, 100, 1500, 850)

        self.manager = ServerManager()
        self.broadcast_mode = False  # 广播模式开关
        self.cli_args = args

        self.init_ui()
        self.refresh_server_tree()

        # Auto-import if --import specified
        if args and args.import_file:
            self.auto_import(args.import_file)

        # Auto-open if --filter specified
        if args and args.filter:
            # Use a timer to open after GUI is ready
            from PyQt5.QtCore import QTimer
            QTimer.singleShot(500, lambda: self.auto_open_filter(args.filter))
    
    def init_ui(self):
        self.setStyleSheet("""
            QMainWindow {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                    stop:0 #0a0e27, stop:0.5 #1a1f3a, stop:1 #0a0e27);
            }
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                border: 2px solid #00d4ff;
                border-radius: 6px;
                color: white;
                font-weight: bold;
                padding: 10px 15px;
                font-size: 10pt;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #00d4ff, stop:1 #0099cc);
            }
            QPushButton:pressed {
                background-color: #ff2a6d;
            }
            QCheckBox {
                color: #00d4ff;
                font-weight: bold;
                font-size: 11pt;
            }
            QCheckBox::indicator {
                width: 20px;
                height: 20px;
                border: 2px solid #00d4ff;
                border-radius: 3px;
                background-color: #1a1f3a;
            }
            QCheckBox::indicator:checked {
                background-color: #ff2a6d;
                border: 2px solid #00ff9f;
            }
            QStatusBar {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ff2a6d, stop:1 #d14081);
                color: white;
                font-weight: bold;
                border-top: 2px solid #00d4ff;
            }
        """)
        
        # 工具栏
        toolbar = QToolBar()
        toolbar.setStyleSheet("""
            QToolBar {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #0a0e27, stop:1 #1a1f3a);
                border-bottom: 2px solid #00d4ff;
                spacing: 10px;
                padding: 8px;
            }
        """)
        self.addToolBar(toolbar)
        
        add_btn = QPushButton("➕ ADD")
        import_btn = QPushButton("📁 IMPORT")
        delete_btn = QPushButton("🗑️ DELETE")
        clear_all_btn = QPushButton("💣 DELETE ALL")
        test_btn = QPushButton("🔍 TEST ALL")
        
        add_btn.clicked.connect(self.add_server)
        import_btn.clicked.connect(self.import_servers)
        delete_btn.clicked.connect(self.remove_server)
        clear_all_btn.clicked.connect(self.clear_all_servers)
        test_btn.clicked.connect(self.test_all_connections)
        
        toolbar.addWidget(add_btn)
        toolbar.addWidget(import_btn)
        toolbar.addWidget(delete_btn)
        toolbar.addWidget(clear_all_btn)
        toolbar.addSeparator()
        toolbar.addWidget(test_btn)
        
        # 中心部件
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        layout = QVBoxLayout(central_widget)
        layout.setContentsMargins(10, 10, 10, 10)
        
        # 分割器
        splitter = QSplitter(Qt.Horizontal)
        
        # 左侧：服务器树
        self.server_tree = CyberpunkTreeWidget()
        self.server_tree.itemDoubleClicked.connect(self.on_server_double_clicked)
        splitter.addWidget(self.server_tree)
        
        # 右侧容器
        right_widget = QWidget()
        right_layout = QVBoxLayout(right_widget)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(5)
        
        # 广播模式控制栏
        broadcast_bar = QHBoxLayout()
        
        self.broadcast_checkbox = QCheckBox("📡 BROADCAST MODE")
        self.broadcast_checkbox.stateChanged.connect(self.toggle_broadcast_mode)
        broadcast_bar.addWidget(self.broadcast_checkbox)
        
        self.broadcast_input = QLineEdit()
        self.broadcast_input.setPlaceholderText("Enter command to send to all tabs...")
        self.broadcast_input.setStyleSheet("""
            QLineEdit {
                background-color: #1a1f3a;
                border: 2px solid #00d4ff;
                border-radius: 5px;
                padding: 10px;
                color: #00ff9f;
                font-family: Consolas;
                font-size: 11pt;
            }
        """)
        self.broadcast_input.returnPressed.connect(self.send_broadcast_command)
        self.broadcast_input.setEnabled(False)
        broadcast_bar.addWidget(self.broadcast_input)
        
        broadcast_send_btn = QPushButton("⚡ SEND ALL")
        broadcast_send_btn.setFixedWidth(120)
        broadcast_send_btn.clicked.connect(self.send_broadcast_command)
        broadcast_bar.addWidget(broadcast_send_btn)
        
        right_layout.addLayout(broadcast_bar)
        
        # 标签页
        self.tab_widget = QTabWidget()
        self.tab_widget.setTabsClosable(True)
        self.tab_widget.tabCloseRequested.connect(self.close_tab)
        self.tab_widget.setStyleSheet("""
            QTabWidget::pane {
                border: 2px solid #00d4ff;
                border-radius: 8px;
                background-color: #0a0e27;
            }
            QTabBar::tab {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #1a1f3a, stop:1 #0a0e27);
                color: #00d4ff;
                padding: 12px 20px;
                margin-right: 2px;
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
                font-weight: bold;
                font-size: 9pt;
            }
            QTabBar::tab:selected {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #ff2a6d, stop:1 #d14081);
                color: white;
            }
            QTabBar::tab:hover {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #00d4ff, stop:1 #0099cc);
                color: white;
            }
        """)
        
        right_layout.addWidget(self.tab_widget)
        
        splitter.addWidget(right_widget)
        splitter.setSizes([300, 1200])
        
        layout.addWidget(splitter)
        
        self.statusBar().showMessage("⚡ SYSTEM READY | TCP KEEPALIVE 15s | API :9876 ⚡")
    
    def toggle_broadcast_mode(self, state):
        """切换广播模式"""
        self.broadcast_mode = (state == Qt.Checked)
        self.broadcast_input.setEnabled(self.broadcast_mode)
        
        if self.broadcast_mode:
            self.statusBar().showMessage("⚡ BROADCAST MODE ENABLED ⚡")
            self.broadcast_input.setFocus()
        else:
            self.statusBar().showMessage("⚡ BROADCAST MODE DISABLED ⚡")
    
    def send_broadcast_command(self):
        """向所有标签页发送命令"""
        if not self.broadcast_mode:
            return
        
        command = self.broadcast_input.text()
        if not command:
            return
        
        # 向所有打开的标签页发送命令
        count = 0
        for i in range(self.tab_widget.count()):
            tab = self.tab_widget.widget(i)
            if isinstance(tab, SSHTab):
                tab.send_command(command + '\n')
                count += 1
        
        self.statusBar().showMessage(f"⚡ Command sent to {count} sessions ⚡")
        self.broadcast_input.clear()
    
    def test_all_connections(self):
        """测试所有服务器连接"""
        if not self.manager.servers:
            QMessageBox.information(self, "INFO", "No servers to test")
            return
        
        # 显示测试对话框
        dialog = ConnectionTestDialog(self.manager.servers, self)
        dialog.exec_()
    
    def clear_all_servers(self):
        """删除所有服务器"""
        if not self.manager.servers:
            QMessageBox.information(self, "INFO", "No servers to delete")
            return
        
        count = len(self.manager.servers)
        reply = QMessageBox.question(
            self, "⚡ CONFIRM", 
            f"Delete ALL {count} servers?\n\nThis cannot be undone!",
            QMessageBox.Yes | QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            self.manager.clear_all()
            self.refresh_server_tree()
            QMessageBox.information(self, "SUCCESS", f"Deleted {count} servers")
            self.statusBar().showMessage("⚡ ALL SERVERS DELETED ⚡")
    
    def refresh_server_tree(self):
        self.server_tree.clear()
        groups = self.manager.get_groups()
        for group in groups:
            group_item = QTreeWidgetItem(self.server_tree, [f"📁 {group}"])
            group_item.setExpanded(True)
            servers = self.manager.get_servers_by_group(group)
            for server in servers:
                server_text = f"🖥️ {server.name} ({server.username}@{server.host})"
                server_item = QTreeWidgetItem(group_item, [server_text])
                server_item.setData(0, Qt.UserRole, server)
    
    def auto_import(self, filename):
        """自动导入服务器列表"""
        try:
            count = self.manager.import_from_file(filename)
            self.refresh_server_tree()
            self.statusBar().showMessage(f"⚡ Auto-imported {count} servers from {filename} ⚡")
            print(f"[AUTO] Imported {count} servers from {filename}")
        except Exception as e:
            print(f"[AUTO] Import error: {e}")

    def auto_open_filter(self, filter_str):
        """自动打开匹配 filter 的服务器（去重：同 name 不重复打开）"""
        opened = 0
        seen = set()
        for server in self.manager.servers:
            if filter_str.upper() in server.name.upper() and server.name not in seen:
                seen.add(server.name)
                self.open_ssh_tab(server)
                opened += 1
        self.statusBar().showMessage(f"⚡ Auto-opened {opened} sessions matching '{filter_str}' ⚡")
        print(f"[AUTO] Opened {opened} sessions matching '{filter_str}'")

    def add_server(self):
        dialog = CyberpunkDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            server = dialog.get_server_config()
            if all([server.name, server.host, server.username]):
                self.manager.add_server(server)
                self.refresh_server_tree()
                QMessageBox.information(self, "SUCCESS", f"Server added: {server.name}")
    
    def import_servers(self):
        filename, _ = QFileDialog.getOpenFileName(self, "Select file", "", "Text (*.txt);;All (*)")
        if filename:
            try:
                count = self.manager.import_from_file(filename)
                self.refresh_server_tree()
                QMessageBox.information(self, "SUCCESS", f"Imported {count} servers")
            except Exception as e:
                QMessageBox.critical(self, "ERROR", str(e))
    
    def remove_server(self):
        item = self.server_tree.currentItem()
        if not item or not item.parent():
            return
        server = item.data(0, Qt.UserRole)
        if server:
            reply = QMessageBox.question(self, "CONFIRM", f"Delete '{server.name}'?")
            if reply == QMessageBox.Yes:
                idx = self.manager.servers.index(server)
                self.manager.remove_server(idx)
                self.refresh_server_tree()
    
    def on_server_double_clicked(self, item, column):
        if not item.parent():
            return
        server = item.data(0, Qt.UserRole)
        if server:
            self.open_ssh_tab(server)
    
    def open_ssh_tab(self, server):
        # 去重：不重复打开同名服务器
        for i in range(self.tab_widget.count()):
            tab = self.tab_widget.widget(i)
            if isinstance(tab, SSHTab) and tab.server.name == server.name:
                self.tab_widget.setCurrentIndex(i)
                return
        tab = SSHTab(server)
        tab.title_changed.connect(lambda title: self.update_tab_title(tab, title))
        index = self.tab_widget.addTab(tab, f"⏳ {server.name}")
        self.tab_widget.setCurrentIndex(index)
    
    def update_tab_title(self, tab, title):
        index = self.tab_widget.indexOf(tab)
        if index >= 0:
            self.tab_widget.setTabText(index, title)
    
    def close_tab(self, index):
        widget = self.tab_widget.widget(index)
        if widget:
            widget.close_session()
        self.tab_widget.removeTab(index)


# ==================== 主程序 ====================

def parse_args():
    parser = argparse.ArgumentParser(description='RemoteX - Cyberpunk SSH Client + Claude Code API')
    parser.add_argument('--import', dest='import_file', metavar='FILE',
                        help='Import servers from ip.txt file on startup')
    parser.add_argument('--filter', metavar='KEYWORD',
                        help='Auto-open servers matching this keyword (e.g. SMAPP)')
    parser.add_argument('--port', type=int, default=9876,
                        help='HTTP API port for Claude Code control (default: 9876)')
    parser.add_argument('--no-api', action='store_true',
                        help='Disable HTTP API server')
    return parser.parse_args()


def main():
    args = parse_args()

    app = QApplication(sys.argv)
    app.setStyle('Fusion')

    window = CyberpunkSSH(args=args)
    window.show()

    # Start HTTP API server for Claude Code (通过信号桥，线程安全)
    if not args.no_api:
        api_bridge = APIBridge(window)
        XShellAPIHandler.bridge = api_bridge
        start_api_server(port=args.port)

        # Start WebSocket terminal server (手机 Web SSH)
        WebTerminalServer.bridge = api_bridge
        WebTerminalServer.start(port=args.port + 1)

    sys.exit(app.exec_())


if __name__ == "__main__":
    main()