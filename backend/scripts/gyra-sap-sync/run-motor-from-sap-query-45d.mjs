// node backend/scripts/gyra-sap-sync/run-motor-from-sap-query-45d.mjs [--dry-run]
import { runGyraSapSync } from './lib/run-gyra-sap-sync.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

runGyraSapSync({
  searchMode: 'STALE_ONLY',
  label: 'run-motor-from-sap-query-45d',
  searchIntervalDays: 45,
  createdFromDate: '2026-05-18',
  dryRun: DRY_RUN,
}).catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
