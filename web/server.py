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
"""
import argparse
import json
import os
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 64 * 1024


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

    def do_GET(self):
        if self.path.split('?')[0] == '/api/llm/config':
            cfg = self.cfg()
            if not cfg or not cfg['endpoints']:
                return self.send_json(404, {'error': 'no llm configured'})
            return self.send_json(200, {'endpoints': [{'path': e['path'], 'model': e.get('model', '')} for e in cfg['endpoints']]})
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith('/api/llm/'):
            return self.send_json(404, {'error': 'not found'})
        cfg = self.cfg()
        sub = self.path[len('/api/llm'):].split('?')[0]
        if not cfg or sub not in [e['path'] for e in cfg['endpoints']]:
            return self.send_json(404, {'error': 'unknown endpoint'})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413, {'error': 'bad body size'})
        body = self.rfile.read(length)
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
    a = ap.parse_args()
    Handler.cfg_path = a.config
    root = os.path.dirname(os.path.abspath(__file__))
    ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=root)).serve_forever()


if __name__ == '__main__':
    main()
