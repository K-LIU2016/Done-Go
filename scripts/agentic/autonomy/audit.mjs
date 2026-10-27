export class AuditLog {
  constructor({ writer } = {}) {
    this.writer = writer ?? (async (event) => { this.events.push(event); });
    this.events = [];
    this.failed = false;
  }

  async append(event) {
    if (this.failed) { const error = new Error('audit unavailable'); error.code = 'AUDIT_WRITE_FAILED'; throw error; }
    try { await this.writer({ ...event, at: event.at ?? new Date().toISOString() }); }
    catch (cause) { this.failed = true; const error = new Error('AUDIT_WRITE_FAILED', { cause }); error.code = 'AUDIT_WRITE_FAILED'; throw error; }
  }
}
