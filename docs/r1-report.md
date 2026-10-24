# Done-Go R1 acceptance report

All acceptance checks use deterministic local fixtures and synthetic configuration. No credentials, real providers, external network, installation, push, or deployment were used. Real-provider 6x3 is **NOT RUN** by design.

| Gate | Command | Exit code | Result |
| --- | --- | ---: | --- |
| Focused R1 suite | `node --test tests/unit/tango-r1-acceptance.test.mjs` | 0 | PASS |
| Permitted unit matrix | `node --test tests/unit/tango-ai-*.test.mjs tests/unit/tango-assistant*.test.mjs tests/unit/tango-model-catalog-cn.test.mjs` | 0 | PASS |
| Web verification (final gate) | `npm run verify:web` | 0 | PASS |

The focused suite covers the exact seven-value `MODES` contract, three local fixture runs for each of the six product modes, upstream failure and parse fallback, parse/prompt total budgets, stream raw-byte and visible-content caps, visitor daily limits and day reset, CN catalog data, and disabled parse/prompt behavior.

Evidence status:

- **VERIFIED:** all listed commands and exit codes after the acceptance runner completes; the six product modes use deterministic local mocks only.
- **VERIFIED:** real-provider 6x3 was not run and no credential or external-network path was exercised.
- **UNKNOWN:** behavior against a real upstream provider, credentials, and production deployment remains unverified.
