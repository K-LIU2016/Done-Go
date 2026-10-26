// Local beta launcher: real account entry (email verification; console transport by default).
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { createAssistant } from './ai-assistant.mjs';
import { applyDotEnv, loadAssistantConfig, saveAssistantMetadata } from './assistant-config.mjs';
import { createCollaborationService } from './collaboration-service.mjs';
import { createTangoServer } from './serve-tango.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
// Load only AI settings from the private project .env; preview auth stays launcher-controlled.
const aiEnv = { ...process.env };
try { await applyDotEnv({ projectRoot, env: aiEnv }); }
catch { process.stderr.write('TANGO_DOTENV_INVALID: AI settings unavailable; preview remains available.\n'); }
// Set ADMIN_EMAILS explicitly to designate a local admin; this launcher has no default personal email.
const designatedAdminEmail = process.env.ADMIN_EMAILS || '';
const requestedDatabase = process.env.AUTH_DATABASE_PATH || process.env.TANGO_AUTH_DB || process.env.TANGO_COLLAB_DB || join(projectRoot, '.tango-donego', 'local-auth-dev', 'collaboration.sqlite');
if (requestedDatabase !== ':memory:' && !isAbsolute(requestedDatabase)) {
 process.stderr.write('TANGO_COLLAB_DB must be an absolute path (or :memory:).\n');
 process.exit(2);
}
// Shell-provided ADMIN_EMAILS and EMAIL_TRANSPORT win; everything else is pinned to this loopback launcher.
if (designatedAdminEmail) process.env.ADMIN_EMAILS = designatedAdminEmail;
process.env.EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT || 'console';
process.env.TANGO_PUBLIC_ORIGIN = '';
process.env.NODE_ENV = 'development';
process.env.ENV = 'development';
const port = Number.isInteger(Number(process.env.TANGO_PORT)) && Number(process.env.TANGO_PORT) > 0 ? Number(process.env.TANGO_PORT) : 5221;
let assistantConfig = {};
try { assistantConfig = await loadAssistantConfig({ projectRoot, env: aiEnv }); }
catch { process.stderr.write('TANGO_AI_CONFIG_INVALID: assistant disabled; auth flows remain available.\n'); }
let assistant = createAssistant({ config: assistantConfig, env: aiEnv });
const delegate = { configuration: () => assistant.configuration(), chat: (input, signal) => assistant.chat(input, signal), streamChat: (input, signal) => assistant.streamChat(input, signal) };
const assistantStore = { save: async patch => { await saveAssistantMetadata({ projectRoot, patch }); assistantConfig = await loadAssistantConfig({ projectRoot, env: aiEnv }); assistant = createAssistant({ config: assistantConfig, env: aiEnv }); } };
const collaboration = await createCollaborationService({ databaseFile: requestedDatabase, assistant: delegate });
const server = createTangoServer({ assistant: delegate, assistantConfigStore: assistantStore, collaboration });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { collaboration.close(); process.exit(0); });
server.listen(port, '127.0.0.1', () => {
 process.stdout.write(`Local auth dev server: http://127.0.0.1:${port}\n`);
 process.stdout.write(`Email transport: ${process.env.EMAIL_TRANSPORT}; admin whitelist: ${process.env.ADMIN_EMAILS}\n`);
 process.stdout.write(`Database: ${requestedDatabase}\n`);
});
