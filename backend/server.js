// server.js
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import XLSX from 'xlsx';
import { pool } from './db.js'; // ✅ use your existing pool
import pinoHttp from 'pino-http';
import logger from './logger.js';
import https from 'https';
import hanaClient from '@sap/hana-client';



dotenv.config();
const PORT = Number(process.env.PORT);
const app = express();
app.use(express.json());
app.use(cors());
const { HANA_SERVER, HANA_PORT, HANA_UID, HANA_PWD, HANA_SCHEMA } = process.env;

// -------------------------
// LOG config
// -------------------------

app.use(
  pinoHttp({
    logger,
    // Only log very specific bits from req/res
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          ip: req.ip || req.socket?.remoteAddress,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
    // Keep INFO unless error/4xx/5xx
    customLogLevel(res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Show a tiny message line
    customSuccessMessage(req, res) {
      return `ok ${req.method} ${req.url} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      return `err ${req.method} ${req.url} ${res.statusCode || 500}`;
    },
    // Attach *just* useful props per request
    customProps(req, res) {
      // note: cnpj only exists on POST /api/report; reportId on GET /api/report/:id
      const cnpj = req.body?.cnpj || req.query?.cnpj;
      const reportId = req.params?.id;
      return {
        cnpj,
        reportId,
      };
    },
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  })
);

// function cryptoRandomId() {
//   return Math.random().toString(36).slice(2) + Date.now().toString(36);
// }


// -------------------------
// Helpers de CNPJ
// -------------------------
function normalizeCNPJNumeric(input = '') {
  return String(input).replace(/\D/g, '');
}

function isValidCNPJ(cnpj) {
  const s = normalizeCNPJNumeric(cnpj);
  if (s.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(s)) return false;

  const calcDV = (base) => {
    let sum = 0, weight = 2;
    for (let i = base.length - 1; i >= 0; i--) {
      sum += Number(base[i]) * weight;
      weight = (weight === 9) ? 2 : weight + 1;
    }
    const mod = sum % 11;
    return (mod < 2) ? 0 : 11 - mod;
  };

  const d1 = calcDV(s.slice(0, 12));
  const d2 = calcDV(s.slice(0, 12) + d1);
  return s.endsWith(`${d1}${d2}`);
}

function formatCNPJMask(digits14) {
  const s = String(digits14 || '');
  if (s.length !== 14) return null;
  return `${s.slice(0,2)}.${s.slice(2,5)}.${s.slice(5,8)}/${s.slice(8,12)}-${s.slice(12,14)}`;
}

// Limpa "{{ ... }}" de descrições
function cleanDescription(text) {
  return (text || '').replace(/\{\{.*?\}\}/g, '').trim();
}

// Extrai company name de values.name no JSON do Gyra+
function extractCompanyName(report) {
  const sections = report?.sections || [];
  for (const sec of sections) {
    for (const det of (sec.sectionDetails || [])) {
      const v = det?.values || {};
      if (typeof v.name === 'string' && v.name.trim()) return v.name.trim();
    }
  }
  return '';
}

// Monta sumário (status, riscos, regras)
function extractReportSummary(report) {
  const statusValue = report?.status?.value || null;
  const sections = report?.sections || [];

  const risksSet = new Set();
  const rulesArr = [];

  sections.forEach((section) => {
    (section.sectionDetails || []).forEach((detail) => {
      const values = detail.values || {};
      if (values.risk) risksSet.add(values.risk);
      
      (values.policyRuleGroupResults || []).forEach((group) => {
        (group.policyRuleResultJoins || []).forEach((join) => {
          (join.policyRuleResults || []).forEach((rule) => {
            const key = rule?.status?.key;
            if (key === 'DENIED' || key === 'ALERT') {
              rulesArr.push({
                description: cleanDescription(rule.descriptions),
                status: rule.status?.value || '',
              });
            }
          });
        });
      });
    });
  });

  const risks = Array.from(risksSet);
  const businessName = extractCompanyName(report);

  return { statusValue, risks, rules: rulesArr, businessName };
}

async function execRows(sql, params = []) {
  const res = await pool.execute(sql, params);
  // mysql2/promise -> [rows, fields]
  if (Array.isArray(res)) return res[0];
  // pg-like -> { rows: [...] }
  if (res && Array.isArray(res.rows)) return res.rows;
  // already rows array
  return res;
}

// ─────────────────────────────────────────────────────────────
// 1) SAP Service Layer session (one login per update)
// ─────────────────────────────────────────────────────────────
const sapHttpsAgent = new https.Agent({ rejectUnauthorized: false }); // self-signed ok

async function sapCreateSession() {
  const payload = {
    CompanyDB: process.env.COMPANYDB_SAP,
    UserName: process.env.SAP_USER,
    Password: process.env.SAP_PASSWORD,
  };

  const resp = await axios.post(
    `${process.env.BASE_SAP}/Login`,
    payload,
    { httpsAgent: sapHttpsAgent, maxRedirects: 0, validateStatus: () => true }
  );

  if (resp.status !== 200) {
    throw new Error(`SAP login failed (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  const setCookie = resp.headers['set-cookie'] || [];
  const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; '); // "B1SESSION=...; ROUTEID=..."

  return axios.create({
    baseURL: process.env.BASE_SAP,
    httpsAgent: sapHttpsAgent,
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
}

async function sapUpdateUltimaAnaliseCredito(sap, cardCode, isoDate) {
  const resp = await sap.patch(
    `/BusinessPartners('${cardCode}')`,
    { U_dtUltimaAnaliseCredito: isoDate },
    { headers: { 'If-Match': '*' } }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`SAP PATCH failed (${resp.status}): ${JSON.stringify(resp.data)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 2) HANA query helpers (to resolve CardCode via CRD7.TaxId0)
// ─────────────────────────────────────────────────────────────

function hanaConnParams() {
  const p = {
    serverNode: `${HANA_SERVER}:${HANA_PORT}`,
    uid: HANA_UID,
    pwd: HANA_PWD,
    // sslValidateCertificate: 'false', // uncomment if you must skip TLS validation
  };
  if (HANA_SCHEMA) p.CURRENTSCHEMA = HANA_SCHEMA;
  return p;
}


async function hanaQueryOne(sql, params = []) {
  const conn = hanaClient.createConnection();
  await new Promise((resolve, reject) =>
    conn.connect(hanaConnParams(), err => (err ? reject(err) : resolve()))
  );

  try {
    const stmt = conn.prepare(sql);
    const rows = await new Promise((resolve, reject) => {
      stmt.exec(params, (err, rs) => (err ? reject(err) : resolve(rs)));
    });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } finally {
    try { conn.disconnect(); } catch (_) {}
  }
}

/** Get CardCode by CNPJ from CRD7.TaxId0 (DB stores formatted; we compare digits-only) */
async function getCardCodeByCNPJ_HANA(cnpjInput) {
  // 1) normalize and validate
  const digits = normalizeCNPJNumeric(cnpjInput || '');
  if (digits.length !== 14) return null;

  // 2) format back to the standard mask (DB stores formatted in CRD7.TaxId0)
  const formatted = formatCNPJMask(digits);
  if (!formatted) return null;

  // 3) try exact formatted match first (fast path, uses index if any)
  {
    const sqlExact = `
      SELECT T0."CardCode"
      FROM CRD7 T0
      JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
      WHERE T0."TaxId0" = ?
      LIMIT 1
    `;
    const row = await hanaQueryOne(sqlExact, [formatted]);
    if (row && row.CardCode) return row.CardCode;
  }

  // 4) fallback: digits-only comparison (handles any odd formatting)
  {
    const sqlDigits = `
      SELECT T0."CardCode"
      FROM CRD7 T0
      JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
      WHERE REPLACE(REPLACE(REPLACE(T0."TaxId0", '.', ''), '/', ''), '-', '') = ?
      LIMIT 1
    `;
    const row = await hanaQueryOne(sqlDigits, [digits]);
    if (row && row.CardCode) return row.CardCode;
  }

  return null;
}
// -------------------------
// Rotas
// -------------------------

// Token Gyra+
app.post('/api/token', async (req, res) => {
  try {
    const response = await axios.post(
      'https://gyra-core.gyramais.com.br/auth/authenticate',
      {},
      {
        headers: {
          'gyra-client-id': process.env.GYRA_CLIENT_ID,
          'gyra-client-secret': process.env.GYRA_CLIENT_SECRET,
          'Content-Type': 'application/json',
        },
      }
    );
    const userId = response.data?.userId;
    req.log.info({ userId }, '✅ Gyra+ token issued');
    res.json({ token: response.data.accessToken });
  } catch (err) {
    req.log.error({ err, gyraMsg: err.response?.data }, '❌ /api/token failed');
    console.error('❌ /api/token:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Criação/reativação de Report (normaliza CNPJ e reusa ≤90 dias)
app.post('/api/report', async (req, res) => {
  const start = Date.now();
  let reused = false;
  try {
    const { token, cnpj, policyId, sector } = req.body;

    const normalized = normalizeCNPJNumeric(cnpj);
    if (!isValidCNPJ(normalized)) {
      return res.status(400).json({ error: 'CNPJ inválido' });
    }
    const formatted = formatCNPJMask(normalized);
    // 1) Verifica se já existe report em ≤ 90 dias para este CNPJ normalizado
  const exists = await execRows(
    `SELECT id, report_id, formatted_cnpj, created_at
      FROM cnpj_reports
      WHERE normalized_cnpj = ?
        AND created_at > NOW() - INTERVAL 90 DAY
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalized]
  );

    if (exists.length) {
      reused = true;
      // (sem custo novo)
      return res.json({
        id: exists[0].report_id,
        reused,
        cnpj: normalized,
        formatted: exists[0].formatted_cnpj || formatted,
      });
    }

    // 2) Cria novo report no Gyra+
    const created = await axios.post(
      'https://gyra-core.gyramais.com.br/report',
      { document: normalized, policyId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const reportId = created.data?.id || created.data?.reportId;

    // 3) Insere na base (sector só no insert)
    await pool.execute(
      `INSERT INTO cnpj_reports (cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [cnpj, normalized, formatted, reportId, sector || null]
    );
    const dur = Date.now() - start;
    req.log.info({ cnpj, sector, reportId, reused, ms: dur }, 'report.create');
    res.json({ id: reportId, reused: false, cnpj: normalized, formatted });

  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'report.create.fail');
    console.error('❌ /api/report:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Report completo + atualização única (ou se estava PENDING)
app.get('/api/report/:id', async (req, res) => {
  const reportId = req.params.id;
  const start = Date.now();
  let createdAt = null;
  let needsUpdate = false;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing Authorization Bearer token' });

    const reportId = req.params.id;

    // 1) DB: created_at
    const createdRows = await execRows(
      'SELECT created_at FROM cnpj_reports WHERE report_id = ? LIMIT 1',
      [reportId]
    );
     createdAt = createdRows?.[0]?.created_at || null;

    // 2) Gyra: full report
    const resp = await axios.get(
      `https://gyra-core.gyramais.com.br/report/${reportId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const fullReport = resp.data;

    // 3) Update DB summary once (or if it was PENDING)
    const rows = await execRows(
      'SELECT status_value FROM cnpj_reports WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    const current = rows?.[0]?.status_value;
    needsUpdate =
      current == null ||
      String(current).trim() === '' ||
      String(current).toUpperCase() === 'PENDING';

    if (needsUpdate) {
      const { statusValue, risks, rules, businessName } = extractReportSummary(fullReport);

      await pool.execute(
        `UPDATE cnpj_reports
            SET status_value = ?,
                risks = ?,
                rules = ?,
                business_name = ?
          WHERE report_id = ?`,
        [
          statusValue || null,
          JSON.stringify(risks || []),
          JSON.stringify(rules || []),
          businessName || null,
          reportId,
        ]
      );
    }
    // 4) Update SAP status if Approved
    const statusFromReport = fullReport?.status?.value || extractReportSummary(fullReport).statusValue;
    const updateSap = String(statusFromReport || '').toUpperCase() === 'APPROVED';
    if (updateSap) {
      try {
        // 4.1) get the CNPJ saved for this report
        const [cnpjRows] = await pool.execute(
          'SELECT cnpj FROM cnpj_reports WHERE report_id = ? LIMIT 1',
          [reportId]
        );
        const cnpjForLookup = cnpjRows?.[0]?.cnpj;

        if (!cnpjForLookup) {
          console.warn('Approved but no CNPJ in DB; skipping SAP update');
          res.set('X-SAP-Update', 'skipped');
          res.set('X-SAP-Reason', 'NO_CNPJ_IN_DB');
        } else {
          // 4.2) resolve CardCode via HANA (CRD7.TaxId0 digits-only match)
          const cardCode = await getCardCodeByCNPJ_HANA(cnpjForLookup);

          if (!cardCode) {
            console.warn('CNPJ not found in CRD7.TaxId0; skipping', cnpjForLookup);
            res.set('X-SAP-Update', 'skipped');
            res.set('X-SAP-Reason', 'BP_NOT_FOUND_FOR_CNPJ');
          } else {
            // 4.3) one login per update → patch U_dtUltimaAnaliseCredito
            const sap = await sapCreateSession();
            const todayStr = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
            await sapUpdateUltimaAnaliseCredito(sap, cardCode, todayStr);

            console.log(`✅ SAP updated U_dtUltimaAnaliseCredito for ${cardCode} (${cnpjForLookup})`);
            res.set('X-SAP-Update', 'success');
            res.set('X-SAP-CardCode', cardCode);
          }
        }
      } catch (e) {
        console.error('❌ SAP update failed:', e.message);
        res.set('X-SAP-Update', 'skipped');
        res.set('X-SAP-Reason', 'SAP_UPDATE_ERROR');
      }
    } else {
      // not approved → nothing to do (optional annotation)
      res.set('X-SAP-Update', 'skipped');
      res.set('X-SAP-Reason', 'NOT_APPROVED');
    }
      
    // 5) Return Gyra data + our DB timestamp
    const dur = Date.now() - start;
    req.log.info({ reportId, createdAt, updated: needsUpdate, ms: dur }, 'report.fetch');
    res.json({...fullReport, createdAt });

  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, reportId, createdAt, updated: needsUpdate, ms: dur }, 'report.fetch.fail');
    console.error('❌ /api/report/:id:', err.response?.data || err.message || err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// Lista (90 dias)
app.get('/api/reports', async (req, res) => {
  try {
    const rows = await execRows(
      `SELECT
         id,
         cnpj,
         normalized_cnpj,
         formatted_cnpj,
         report_id,
         sector,
         business_name,
         status_value,
         risks,
         rules,
         created_at
       FROM cnpj_reports
       WHERE created_at > NOW() - INTERVAL 90 DAY
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/reports:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export XLSX (90 dias)
app.get('/api/reports.xlsx', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, business_name, status_value, created_at
         FROM cnpj_reports
        WHERE created_at > NOW() - INTERVAL 90 DAY
        ORDER BY created_at DESC`
    );

    const data = rows.map((r) => ({
      ID: r.id,
      CNPJ_ORIGINAL: r.cnpj,
      CNPJ_NORMALIZADO: r.normalized_cnpj,
      CNPJ_FORMATADO: r.formatted_cnpj, // ✅ incluído
      REPORT_ID: r.report_id,
      SETOR: r.sector,
      NOME_EMPRESA: r.business_name,
      STATUS_GERAL: r.status_value,
      CRIADO_EM: r.created_at,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'reports_90d');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="reports_90d.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error('❌ /api/reports.xlsx:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Static frontend mounted at /motorcredito ---
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distPath = path.resolve(__dirname, '../dist');
console.log('Serving frontend from:', distPath);

if (!fs.existsSync(path.join(distPath, 'index.html'))) {
  console.error('⚠️ dist/index.html not found. Run "npm run build" at project root.');
}

// Serve static files under /motorcredito
app.use('/motorcredito', express.static(distPath, { maxAge: '7d', etag: true }));

// SPA fallback for any /motorcredito/* route
app.get('/motorcredito/*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});


app.listen(PORT, () => {
  console.log(`✅ Backend API ready at http://localhost:${PORT}`);
});
