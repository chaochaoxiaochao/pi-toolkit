#!/usr/bin/env python3
"""JSON-lines bridge between a real Pi PTY and the browser media recorder."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 130, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
pending = b''
try:
    while child.poll() is None:
        readable, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.1)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            print(json.dumps({'output': base64.b64encode(data).decode()}), flush=True)
        if sys.stdin.buffer in readable:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if 'input' in message:
                    os.write(master, message['input'].encode())
                if 'size' in message:
                    cols, rows = message['size']
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
finally:
    if child.poll() is None:
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
