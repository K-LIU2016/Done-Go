#!/usr/bin/env python3
"""留白 self-hosted server: serves this folder and forwards AI calls to a local LLM.

    python3 web/server.py --port 8737 --config ~/.config/leubai/llm.json

The config file stays on the host (never in the repo):

    {
      "upstream": "http://127.0.0.1:3458",
      "key": "<api key>",
      "endpoints": [
        {"path": "/v1/messages", "model": "glm-5.3-flash"},
        {"path": "/v1/messages-2", "model": "gpt-6-luna"}
      ]
    }

The page reads GET /api/llm/config (paths and models only, never the key) and
posts Anthropic-style Messages requests to /api/llm/<path>. Only the listed
paths are forwarded, and the key is added here, so browsers never see it.
Bind to 127.0.0.1 and publish with `tailscale serve` to keep it on the tailnet.

The firework board lives in --board (a small JSON file on the host). GET
/api/board returns everyone's daily firework counts; POST /api/board saves the
caller's own {id, nick, days}. Anyone on the tailnet can read and post.
"""
import argparse
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 64 * 1024
BOARD_LOCK = threading.Lock()
BOARD_MAX_PEOPLE = 200
ID_RE = re.compile(r'^[A-Za-z0-9_-]{6,40}$')
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def read_board(path):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def clean_entry(obj):
    if not isinstance(obj, dict) or not ID_RE.match(str(obj.get('id', ''))):
        return None
    days = obj.get('days')
    if not isinstance(days, dict):
        return None
    keep = {}
    for k in sorted(days)[-62:]:
        v = days[k]
        if DAY_RE.match(str(k)) and isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 999:
            keep[k] = v
    nick = str(obj.get('nick') or '').strip()[:20]
    return {'id': obj['id'], 'nick': nick, 'days': keep, 'at': int(time.time())}


def load_config(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    cfg['upstream'] = cfg.get('upstream', 'http://127.0.0.1:3458').rstrip('/')
    cfg['endpoints'] = [e for e in cfg.get('endpoints', []) if str(e.get('path', '')).startswith('/')]
    return cfg


class Handler(SimpleHTTPRequestHandler):
    cfg_path = None
    board_path = None

    def cfg(self):
        try:
            return load_config(self.cfg_path)
        except (OSError, ValueError):
            return None

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length)

    def do_GET(self):
        if self.path.split('?')[0] == '/api/board':
            with BOARD_LOCK:
                board = read_board(self.board_path)
            return self.send_json(200, {'people': list(board.values())})
        if self.path.split('?')[0] == '/api/llm/config':
            cfg = self.cfg()
            if not cfg or not cfg['endpoints']:
                return self.send_json(404, {'error': 'no llm configured'})
            return self.send_json(200, {'endpoints': [{'path': e['path'], 'model': e.get('model', '')} for e in cfg['endpoints']]})
        return super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] == '/api/board':
            body = self.read_body()
            try:
                entry = clean_entry(json.loads(body)) if body else None
            except ValueError:
                entry = None
            if not entry:
                return self.send_json(400, {'error': 'bad entry'})
            with BOARD_LOCK:
                board = read_board(self.board_path)
                if entry['id'] not in board and len(board) >= BOARD_MAX_PEOPLE:
                    return self.send_json(507, {'error': 'board full'})
                board[entry['id']] = entry
                os.makedirs(os.path.dirname(self.board_path), exist_ok=True)
                tmp = self.board_path + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(board, f, ensure_ascii=False)
                os.replace(tmp, self.board_path)
            return self.send_json(200, {'ok': True})
        if not self.path.startswith('/api/llm/'):
            return self.send_json(404, {'error': 'not found'})
        cfg = self.cfg()
        sub = self.path[len('/api/llm'):].split('?')[0]
        if not cfg or sub not in [e['path'] for e in cfg['endpoints']]:
            return self.send_json(404, {'error': 'unknown endpoint'})
        body = self.read_body()
        if body is None:
            return self.send_json(413, {'error': 'bad body size'})
        req = urllib.request.Request(cfg['upstream'] + sub, data=body, method='POST', headers={
            'Content-Type': 'application/json',
            'x-api-key': cfg.get('key', ''),
            'Authorization': 'Bearer ' + cfg.get('key', ''),
            'anthropic-version': self.headers.get('anthropic-version') or '2023-06-01',
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
        except (urllib.error.URLError, OSError) as e:
            return self.send_json(502, {'error': 'upstream unreachable: %s' % e})
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8737)
    ap.add_argument('--config', default=os.path.expanduser('~/.config/leubai/llm.json'))
    ap.add_argument('--board', default=os.path.expanduser('~/.local/share/leubai/board.json'))
    a = ap.parse_args()
    Handler.cfg_path = a.config
    Handler.board_path = a.board
    root = os.path.dirname(os.path.abspath(__file__))
    ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=root)).serve_forever()


if __name__ == '__main__':
    main()
