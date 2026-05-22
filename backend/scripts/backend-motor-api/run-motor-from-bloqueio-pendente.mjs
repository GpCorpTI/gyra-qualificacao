// node backend/scripts/backend-motor-api/run-motor-from-bloqueio-pendente.mjs [--dry-run]
import dotenv from 'dotenv';
import axios from 'axios';
import hanaClient from '@sap/hana-client';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const {
  HANA_SERVER,
  HANA_PORT,
  HANA_UID,
  HANA_PWD,
  HANA_SCHEMA,
  MOTOR_API_BASE_URL = process.env.MOTOR_BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  MOTOR_API_POLICY_ID = process.env.MOTOR_POLICY_ID || process.env.GYRA_POLICY_ID,
  MOTOR_API_SECTOR = process.env.MOTOR_SECTOR || 'CRDT',
  MOTOR_API_REQUEST_DELAY_MS = process.env.MOTOR_REQUEST_DELAY_MS || '500',
  MOTOR_API_MAX_ROWS = process.env.MOTOR_MAX_ROWS || '0',
  MOTOR_API_TIMEOUT_MS = '180000',
  MOTOR_BLOQUEIO_PROCEDURE = '"SBO_GPIMPORTS"."spcBloqueioGPFIN04Pendente"',
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`[ENV ERROR] Missing ${name}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCNPJ(value = '') {
  return String(value).replace(/\D/g, '');
}

function formatCNPJ(digits) {
  const s = normalizeCNPJ(digits);
  if (s.length !== 14) return s;
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12, 14)}`;
}

function hanaConnParams() {
  const params = {
    serverNode: `${HANA_SERVER}:${Number(HANA_PORT || 30015)}`,
    uid: HANA_UID,
    pwd: HANA_PWD,
  };
  if (HANA_SCHEMA) params.CURRENTSCHEMA = HANA_SCHEMA;
  return params;
}

async function hanaExecute(sql, params = []) {
  const conn = hanaClient.createConnection();
  await new Promise((resolve, reject) => {
    conn.connect(hanaConnParams(), (err) => (err ? reject(err) : resolve()));
  });

  try {
    const stmt = conn.prepare(sql);
    return await new Promise((resolve, reject) => {
      stmt.exec(params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  } finally {
    try {
      conn.disconnect();
    } catch {}
  }
}

function unwrapRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) {
    if (result.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      return result;
    }

    for (const item of result) {
      const rows = unwrapRows(item);
      if (rows.length) return rows;
    }
  }

  if (result && typeof result === 'object') {
    for (const value of Object.values(result)) {
      const rows = unwrapRows(value);
      if (rows.length) return rows;
    }
  }

  return [];
}

function findValueByHints(row, hints = []) {
  const entries = Object.entries(row || {});
  for (const hint of hints) {
    const match = entries.find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, '').includes(hint));
    if (match && match[1] != null && String(match[1]).trim() !== '') return match[1];
  }
  return '';
}

async function fetchProcedureCandidates() {
  const result = await hanaExecute(`CALL ${MOTOR_BLOQUEIO_PROCEDURE}`);
  const rows = unwrapRows(result);
  const maxRows = Number(MOTOR_API_MAX_ROWS || 0);
  const limitedRows = maxRows > 0 ? rows.slice(0, maxRows) : rows;
  const seen = new Set();
  const candidates = [];

  for (const row of limitedRows) {
    const cardCode = String(findValueByHints(row, ['cardcode', 'card']) || '').trim();
    const cnpj = normalizeCNPJ(findValueByHints(row, ['cnpj', 'taxid0', 'lictradnum']));

    if (cnpj.length !== 14) continue;

    const key = `${cardCode || 'NO_CARD'}|${cnpj}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      cardCode,
      cnpj,
      formattedCnpj: formatCNPJ(cnpj),
      raw: row,
    });
  }

  return candidates;
}

function createMotorApi() {
  return axios.create({
    baseURL: MOTOR_API_BASE_URL.replace(/\/$/, ''),
    timeout: Number(MOTOR_API_TIMEOUT_MS || 180000),
  });
}

async function runFrontendLikeMotorFlow(api, cnpj) {
  const tokenResponse = await api.post('/api/token');
  const token = tokenResponse.data?.token;

  if (!token) {
    throw new Error('Backend nao retornou token em /api/token.');
  }

  const createResponse = await api.post('/api/report', {
    token,
    cnpj,
    policyId: MOTOR_API_POLICY_ID,
    sector: MOTOR_API_SECTOR,
  });

  const reportId = createResponse.data?.reportId || createResponse.data?.id;
  if (!reportId) {
    throw new Error('Backend nao retornou reportId em /api/report.');
  }

  const reportResponse = await api.get(`/api/report/${reportId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    reportId,
    reused: Boolean(createResponse.data?.reused),
    formatted: createResponse.data?.formatted || cnpj,
    statusKey: reportResponse.data?.status?.key || '',
    statusValue: reportResponse.data?.status?.value || '',
    companyName: reportResponse.data?.companyName || reportResponse.data?.businessName || '',
    createdAt: reportResponse.data?.createdAt || null,
  };
}

async function main() {
  [
    'HANA_SERVER',
    'HANA_PORT',
    'HANA_UID',
    'HANA_PWD',
    'MOTOR_API_POLICY_ID',
  ].forEach((name) => requireEnv(name, name === 'MOTOR_API_POLICY_ID' ? MOTOR_API_POLICY_ID : process.env[name]));

  const delayMs = Number(MOTOR_API_REQUEST_DELAY_MS || 0);
  const api = createMotorApi();

  console.log(`[START] run-motor-from-bloqueio-pendente ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`[INFO] HANA ${HANA_UID}@${HANA_SERVER}:${HANA_PORT}${HANA_SCHEMA ? ` (schema ${HANA_SCHEMA})` : ''}`);
  console.log(`[INFO] Procedure ${MOTOR_BLOQUEIO_PROCEDURE}`);
  console.log(`[INFO] Backend API ${MOTOR_API_BASE_URL} | policy=${MOTOR_API_POLICY_ID} | sector=${MOTOR_API_SECTOR}`);

  const candidates = await fetchProcedureCandidates();
  console.log(`[INFO] ${candidates.length} registro(s) elegivel(is) retornado(s) pela procedure.`);

  let ok = 0;
  let failed = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const label = `${candidate.formattedCnpj}${candidate.cardCode ? ` | ${candidate.cardCode}` : ''}`;

    try {
      console.log(`-> ${label}`);

      if (DRY_RUN) {
        console.log(`   [DRY-RUN] chamaria /api/token, /api/report e /api/report/:id para ${candidate.formattedCnpj}`);
        ok += 1;
      } else {
        const result = await runFrontendLikeMotorFlow(api, candidate.cnpj);
        console.log(
          `   [OK] reportId=${result.reportId} reused=${result.reused} status=${result.statusKey || result.statusValue || '-'}`
        );
        ok += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`   [FAIL] ${label} -> ${err.response?.data?.error || err.message}`);
    }

    if (delayMs > 0 && index < candidates.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log(`[DONE] ok=${ok} failed=${failed}`);
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
