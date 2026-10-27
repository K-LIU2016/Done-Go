// W12 现场感知：自写最小流式 multipart/form-data 解析器（RFC 7578 子集）。
// 仓库无现成实现且禁新增依赖（BUILD-PLAN §2.3），按字节级状态机手写：
//   - parseMultipart(body, contentType, opts)：整段一次性解析（路由层 /api/captures 用）
//   - MultipartParser：流式 write/end，可跨 chunk 边界喂字节（上传转发场景用）
// 文件名只如实上报（含 "../" 之类），清洗与落盘是 store 层的职责；
// 体积上限在 parseMultipart 入口先查（"before doing any work"）。
'use strict';

/** 默认整包上限：视频 60MB + multipart 编码开销（BUILD-PLAN §3 W12-1）。 */
export const DEFAULT_MAX_BYTES = 70 * 1024 * 1024;

/** 从 Content-Type 里取 boundary 参数；非 multipart / 缺 boundary 直接抛错。 */
export function extractBoundary(contentType) {
  if (typeof contentType !== 'string' || !/^multipart\/form-data/i.test(contentType.trim())) {
    throw new Error(`multipart parser: unsupported content-type "${contentType}" (expected multipart/form-data)`);
  }
  for (const param of contentType.split(';').slice(1)) {
    const m = /^\s*boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))\s*$/i.exec(param);
    if (m) return m[1] !== undefined ? m[1] : m[2];
  }
  throw new Error('multipart parser: content-type missing boundary parameter');
}

/** 解析 Content-Disposition 的参数（name/filename，支持引号与反斜杠转义、无引号回退）。 */
function parseDispositionParams(value) {
  const out = {};
  const re = /;\s*([\w*]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))/g;
  let m;
  while ((m = re.exec(value))) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return out;
}

/** 部件头块（\r\n\r\n 之前）→ { name, filename?, contentType }。 */
function parsePartHeaders(block) {
  let disposition = '';
  let contentType = 'application/octet-stream';
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') disposition = value;
    else if (key === 'content-type') contentType = value;
  }
  const params = parseDispositionParams(disposition);
  return { name: params.name, filename: params.filename, contentType };
}

/**
 * 流式解析器：write(chunk) 可任意切分喂入（chunk 边界落在定界符/头部中间都行），
 * end() 校验必须有收尾定界符（--boundary--），否则视为截断抛 malformed。
 */
export class MultipartParser {
  constructor(boundary) {
    if (typeof boundary !== 'string' || !boundary) throw new Error('multipart parser: empty boundary');
    this.delim = Buffer.from(`--${boundary}`);
    this.sep = Buffer.concat([Buffer.from('\r\n'), this.delim]); // 部件数据的结束定界
    this.buf = Buffer.alloc(0);
    this.state = 'preamble'; // preamble → delim → headers → body → delim … → epilogue
    this.done = false;
    this.fields = {};
    this.files = [];
    this.part = null;
  }

  write(chunk) {
    const data = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk ?? '');
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    drain(this);
    return this;
  }

  end() {
    drain(this);
    if (!this.done) throw new Error('malformed multipart body: missing terminating boundary');
    return this;
  }
}

function drain(p) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    switch (p.state) {
      case 'preamble': {
        const idx = p.buf.indexOf(p.delim);
        if (idx === -1) {
          // 前奏不可能是正文：只保留可能与定界符重叠的尾部，防无界增长
          const keep = p.delim.length - 1;
          if (p.buf.length > keep) p.buf = p.buf.subarray(p.buf.length - keep);
          break;
        }
        p.buf = p.buf.subarray(idx + p.delim.length);
        p.state = 'delim';
        progressed = true;
        break;
      }
      case 'delim': {
        if (p.buf.length < 2) break; // 等下一 chunk
        if (p.buf[0] === 0x2d && p.buf[1] === 0x2d) { // "--"：收尾
          p.buf = p.buf.subarray(2);
          p.state = 'epilogue';
          p.done = true;
          progressed = true;
          break;
        }
        if (p.buf[0] === 0x0d && p.buf[1] === 0x0a) { // "\r\n"：下一部件
          p.buf = p.buf.subarray(2);
          p.state = 'headers';
          progressed = true;
          break;
        }
        throw new Error('malformed multipart body: unexpected bytes after boundary');
      }
      case 'headers': {
        const end = p.buf.indexOf('\r\n\r\n');
        if (end === -1) break;
        const block = p.buf.subarray(0, end).toString('latin1');
        p.buf = p.buf.subarray(end + 4);
        p.part = parsePartHeaders(block);
        p.state = 'body';
        progressed = true;
        break;
      }
      case 'body': {
        const idx = p.buf.indexOf(p.sep);
        if (idx === -1) break;
        emit(p, p.buf.subarray(0, idx));
        p.buf = p.buf.subarray(idx + p.sep.length);
        p.state = 'delim';
        progressed = true;
        break;
      }
      default: { // epilogue：收尾后的传输填充，丢弃
        p.buf = Buffer.alloc(0);
      }
    }
  }
}

function emit(p, data) {
  const part = p.part || {};
  if (!part.name) throw new Error('malformed multipart body: part without name');
  if (part.filename !== undefined) {
    p.files.push({ name: part.name, filename: part.filename, contentType: part.contentType, data });
  } else {
    p.fields[part.name] = data.toString('utf8');
  }
}

/**
 * 整段解析：{ fields: {name→文本}, files: [{name, filename, contentType, data}] }。
 * opts.maxBytes —— 请求体整体上限，超限在解析开始前抛错（413 语义）。
 */
export function parseMultipart(body, contentType, opts = {}) {
  const boundary = extractBoundary(contentType);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  if (data.length > maxBytes) {
    throw new Error(`multipart body too large: ${data.length} bytes exceeds max ${maxBytes} bytes`);
  }
  const parser = new MultipartParser(boundary);
  parser.write(data);
  parser.end();
  return { fields: parser.fields, files: parser.files };
}
