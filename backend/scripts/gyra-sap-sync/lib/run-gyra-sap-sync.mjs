import dotenv from 'dotenv';
import https from 'https';
import axios from 'axios';
import hanaClient from '@sap/hana-client';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const {
  HANA_SERVER,
  HANA_PORT,
  HANA_UID,
  HANA_PWD,
  HANA_SCHEMA,
  BASE_SAP,
  COMPANYDB_SAP,
  SAP_USER,
  SAP_PASSWORD,
  GYRA_CLIENT_ID,
  GYRA_CLIENT_SECRET,
  GYRA_POLICY_ID,
  GYRA_BASE_URL = 'https://gyra-core.gyramais.com.br',
  MOTOR_MAX_ROWS = '0',
  MOTOR_REQUEST_DELAY_MS = '500',
  GYRA_SOURCEPN_VALUE = 'MEGAGP',
  GYRA_SEARCH_INTERVAL_DAYS = '45',
  GYRA_CREATED_FROM_DATE = '2026-05-18',
  GYRA_PENDING_RETRY_DELAY_MS = '180000',
  GYRA_HTTP_TIMEOUT_MS = '120000',
  SAP_PARTNER_DOCS_FIELD = 'U_partnerdocs',
  CNPJ_SOURCE_SQL,
  CNPJ_SOURCE_SQL_NULL,
  CNPJ_SOURCE_SQL_STALE,
} = process.env;

const sapHttpsAgent = new https.Agent({ rejectUnauthorized: false });

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

function formatCPF(digits) {
  const s = normalizeCNPJ(digits);
  if (s.length !== 11) return s;
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9, 11)}`;
}

function formatIsoDateLocal(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveCreatedFromIso(createdFromDate = '') {
  return createdFromDate || GYRA_CREATED_FROM_DATE;
}

function normalizePlainText(input = '') {
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function parseCurrencyNumber(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.replace(/[^\d,.-]/g, '');
  if (!normalized || !/\d/.test(normalized)) return null;

  const asNumber = normalized.includes(',')
    ? normalized.replace(/\./g, '').replace(',', '.')
    : normalized;

  const parsed = Number.parseFloat(asNumber);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanDescription(text) {
  return String(text || '').replace(/\{\{.*?\}\}/g, '').replace(/\s+/g, ' ').trim();
}

function extractPolicyRuleResults(report) {
  const results = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node.policyRuleResults)) {
      results.push(...node.policyRuleResults);
    }

    Object.values(node).forEach((value) => {
      if (value && typeof value === 'object') walk(value);
    });
  };

  walk(report);
  return results;
}

function extractPreApprovedCreditLine(report) {
  const rules = extractPolicyRuleResults(report);

  for (const rule of rules) {
    const description = cleanDescription(rule?.descriptions || '');
    if (!description) continue;

    const normalized = normalizePlainText(description);
    if (!normalized.includes('LIMITE PRE APROVADO DE')) continue;

    const matchedValue = description.match(/LIMITE\s+PR[EÉ]\s+APROVADO\s+DE\s*(R\$\s*)?([\d.,]+)/i);
    const parsed = parseCurrencyNumber(matchedValue?.[2] || matchedValue?.[0] || '');
    if (parsed != null) {
      return {
        creditLine: parsed,
        description,
      };
    }
  }

  return { creditLine: null, description: '' };
}

function findSection(report, typeValue) {
  return (report?.sections || []).find((section) => section?.type?.value === typeValue) || null;
}

function findResponseValues(report) {
  const basic = findSection(report, 'BASIC_INFORMATION');
  for (const detail of basic?.sectionDetails || []) {
    if (detail?.values?.response) return detail.values.response;
  }
  return {};
}

function isCurrentQsaRelationship(relationship, companyDocument) {
  const relationshipType = String(relationship?.relationshipType || '').toUpperCase();
  const relatedTo = normalizeCNPJ(relationship?.relatedTo || '');
  const normalizedCompanyDocument = normalizeCNPJ(companyDocument || '');
  const relationshipState = String(relationship?.type || '').toUpperCase();

  return (
    relationshipType === 'QSA' &&
    !!relationship?.name &&
    !!relatedTo &&
    relatedTo === normalizedCompanyDocument &&
    (
      relationshipState === 'CURRENT' ||
      relationship?.endDate === '-' ||
      String(relationship?.formattedStartDate || '').includes('Atual')
    )
  );
}

function addCurrentOwner(owner, owners, seen) {
  if (!owner?.nome) return;

  const key = `${String(owner.nome).trim()}|${String(owner.documento || '').trim()}`;
  if (seen.has(key)) return;

  seen.add(key);
  owners.push(owner);
}

function extractCurrentOwners(report, normalizedCnpj, formattedCnpj) {
  const response = findResponseValues(report);
  const companyDocument = formattedCnpj || response?.cnpj || formatCNPJ(normalizedCnpj) || normalizedCnpj;
  const relationshipOwners = [];
  const responseOwners = [];
  const seen = new Set();

  for (const section of report?.sections || []) {
    for (const detail of section?.sectionDetails || []) {
      const relationshipSources = [
        detail?.values?.directDataRelationships,
        detail?.values?.relationships,
      ];

      relationshipSources.forEach((source) => {
        if (!Array.isArray(source)) return;

        source.forEach((relationship) => {
          if (!isCurrentQsaRelationship(relationship, companyDocument)) return;

          addCurrentOwner(
            {
              nome: relationship.name,
              cargo: relationship.relationship || 'Nao identificado',
              documento: relationship.document || null,
              dataEntrada: relationship.startDate || null,
              percentualParticipacao: relationship.participation || null,
            },
            relationshipOwners,
            seen
          );
        });
      });
    }
  }

  if (Array.isArray(response?.socios)) {
    response.socios.forEach((owner) => {
      const ownerName = String(owner?.nome || '').trim();
      const ownerDocument = String(owner?.documento || '').trim();
      const matchesCurrentRelationship = relationshipOwners.some((relationshipOwner) => (
        (ownerDocument && relationshipOwner.documento && ownerDocument === relationshipOwner.documento) ||
        (ownerName && relationshipOwner.nome && ownerName === relationshipOwner.nome)
      ));

      if (relationshipOwners.length && !matchesCurrentRelationship) return;

      addCurrentOwner(
        {
          nome: owner?.nome,
          cargo: owner?.cargo || 'Nao identificado',
          documento: owner?.documento || null,
          dataEntrada: owner?.dataEntrada || null,
          percentualParticipacao: owner?.percentualParticipacao || null,
        },
        responseOwners,
        seen
      );
    });
  }

  return relationshipOwners.length ? [...relationshipOwners, ...responseOwners] : responseOwners;
}

function extractCurrentOwnerDocuments(report, normalizedCnpj, formattedCnpj) {
  const owners = extractCurrentOwners(report, normalizedCnpj, formattedCnpj);
  const seen = new Set();
  const documents = [];

  owners.forEach((owner) => {
    const digits = normalizeCNPJ(owner?.documento || '');
    if (digits.length !== 11 || seen.has(digits)) return;
    seen.add(digits);
    documents.push(formatCPF(digits));
  });

  return documents;
}

function getGyraStatusKey(report) {
  const key = normalizePlainText(report?.status?.key || '');
  if (key) return key;

  const value = normalizePlainText(report?.status?.value || '');
  if (value.includes('APPROV')) return 'APPROVED';
  if (value.includes('REJECT')) return 'REJECTED';
  if (value.includes('PEND')) return 'PENDING';
  if (value.includes('DENIED')) return 'DENIED';
  if (value.includes('ALERT')) return 'ALERT';
  return value || 'UNKNOWN';
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

async function hanaQuery(sql, params = []) {
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

function buildDefaultSourceSql(searchMode) {
  const baseSelect = `
    SELECT
      T0."CardCode",
      T0."CardName",
      T0."LicTradNum" AS "CNPJ",
      T0."U_sourcepn" AS "SourcePn",
      T0."CreateDate" AS "CreateDate",
      T0."U_U_GYRA_SEARCH_DATE" AS "GyraSearchDate"
    FROM OCRD T0
    WHERE T0."U_sourcepn" = ?
      AND CAST(T0."CreateDate" AS DATE) >= TO_DATE(?, 'YYYY-MM-DD')
  `;

  if (searchMode === 'NULL_ONLY') {
    return `
      ${baseSelect}
        AND T0."U_U_GYRA_SEARCH_DATE" IS NULL
      ORDER BY T0."CardCode"
    `;
  }

  return `
    ${baseSelect}
      AND T0."U_U_GYRA_SEARCH_DATE" IS NOT NULL
      AND CAST(T0."U_U_GYRA_SEARCH_DATE" AS DATE) <= TO_DATE(?, 'YYYY-MM-DD')
    ORDER BY T0."CardCode"
  `;
}

function resolveSourceSql(searchMode) {
  if (searchMode === 'NULL_ONLY') {
    return CNPJ_SOURCE_SQL_NULL || CNPJ_SOURCE_SQL || buildDefaultSourceSql(searchMode);
  }

  return CNPJ_SOURCE_SQL_STALE || CNPJ_SOURCE_SQL || buildDefaultSourceSql(searchMode);
}

function resolveSourceSqlParams(searchMode, thresholdIso, createdFromIso) {
  const usingCustomSql = searchMode === 'NULL_ONLY'
    ? Boolean(CNPJ_SOURCE_SQL_NULL || CNPJ_SOURCE_SQL)
    : Boolean(CNPJ_SOURCE_SQL_STALE || CNPJ_SOURCE_SQL);

  if (usingCustomSql) return [];
  if (searchMode === 'NULL_ONLY') return [GYRA_SOURCEPN_VALUE, createdFromIso];
  return [GYRA_SOURCEPN_VALUE, createdFromIso, thresholdIso];
}

async function fetchCandidatesFromSap(searchMode, { searchIntervalDays, createdFromDate } = {}) {
  const thresholdDate = new Date();
  const resolvedSearchIntervalDays = Number(searchIntervalDays || GYRA_SEARCH_INTERVAL_DAYS || 45);
  thresholdDate.setDate(thresholdDate.getDate() - resolvedSearchIntervalDays);
  const thresholdIso = formatIsoDateLocal(thresholdDate);
  const createdFromIso = resolveCreatedFromIso(createdFromDate);
  const sql = resolveSourceSql(searchMode);
  const params = resolveSourceSqlParams(searchMode, thresholdIso, createdFromIso);
  const rows = await hanaQuery(sql, params);

  const maxRows = Number(MOTOR_MAX_ROWS || 0);
  const limitedRows = maxRows > 0 ? rows.slice(0, maxRows) : rows;
  const seen = new Set();
  const candidates = [];

  for (const row of limitedRows) {
    const rawCnpj = row?.CNPJ ?? row?.cnpj ?? row?.LicTradNum ?? row?.LICTRADNUM;
    const normalizedCnpj = normalizeCNPJ(rawCnpj);
    const cardCode = row?.CardCode ?? row?.CARDCODE ?? row?.cardcode ?? '';

    if (normalizedCnpj.length !== 14 || !cardCode || seen.has(cardCode)) continue;
    seen.add(cardCode);

    candidates.push({
      cardCode: String(cardCode).trim(),
      cardName: String(row?.CardName ?? row?.CARDNAME ?? row?.cardname ?? '').trim(),
      cnpj: normalizedCnpj,
      formattedCnpj: formatCNPJ(normalizedCnpj),
      createdAt: row?.CreateDate ?? row?.CREATEDATE ?? row?.createdate ?? null,
      lastGyraSearchDate: row?.GyraSearchDate ?? row?.GYRASEARCHDATE ?? row?.U_U_GYRA_SEARCH_DATE ?? null,
    });
  }

  return candidates;
}

async function requestGyraToken() {
  const response = await axios.post(
    `${GYRA_BASE_URL.replace(/\/$/, '')}/auth/authenticate`,
    {},
    {
      headers: {
        'gyra-client-id': GYRA_CLIENT_ID,
        'gyra-client-secret': GYRA_CLIENT_SECRET,
        'Content-Type': 'application/json',
      },
      timeout: Number(GYRA_HTTP_TIMEOUT_MS || 120000),
    }
  );

  if (!response.data?.accessToken) {
    throw new Error('GYRA nao retornou accessToken.');
  }

  return response.data.accessToken;
}

async function createGyraReport(token, cnpj) {
  const response = await axios.post(
    `${GYRA_BASE_URL.replace(/\/$/, '')}/report`,
    { document: cnpj, policyId: GYRA_POLICY_ID },
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: Number(GYRA_HTTP_TIMEOUT_MS || 120000),
    }
  );

  const reportId = response.data?.id || response.data?.reportId;
  if (!reportId) {
    throw new Error('GYRA nao retornou reportId ao criar o relatorio.');
  }

  return reportId;
}

async function fetchGyraReport(token, reportId) {
  const response = await axios.get(
    `${GYRA_BASE_URL.replace(/\/$/, '')}/report/${reportId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: Number(GYRA_HTTP_TIMEOUT_MS || 120000),
    }
  );

  return response.data;
}

async function fetchGyraReportWithPendingRetry(token, cnpj) {
  const reportId = await createGyraReport(token, cnpj);
  let report = await fetchGyraReport(token, reportId);
  let retriedPending = false;

  if (getGyraStatusKey(report) === 'PENDING') {
    retriedPending = true;
    console.log(`   [PENDING] ${formatCNPJ(cnpj)} aguardando 3 minutos para segunda tentativa...`);
    await sleep(Number(GYRA_PENDING_RETRY_DELAY_MS || 180000));
    report = await fetchGyraReport(token, reportId);
  }

  return {
    reportId,
    report,
    retriedPending,
  };
}

async function sapLogin() {
  const payload = {
    CompanyDB: COMPANYDB_SAP,
    UserName: SAP_USER,
    Password: SAP_PASSWORD,
  };

  const response = await axios.post(`${BASE_SAP}/Login`, payload, {
    httpsAgent: sapHttpsAgent,
    maxRedirects: 0,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`SAP Login failed (${response.status}): ${JSON.stringify(response.data)}`);
  }

  const setCookie = response.headers['set-cookie'] || [];
  const cookieHeader = setCookie.map((cookie) => cookie.split(';')[0]).join('; ');

  return axios.create({
    baseURL: BASE_SAP,
    httpsAgent: sapHttpsAgent,
    headers: {
      Cookie: cookieHeader,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });
}

async function patchBusinessPartner(sap, cardCode, payload) {
  const response = await sap.patch(
    `/BusinessPartners('${cardCode}')`,
    payload,
    { headers: { 'If-Match': '*' } }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`PATCH ${cardCode} failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
}

function buildSapUpdatePayload({
  statusKey,
  reportId,
  searchDate,
  approvedCreditLine = null,
  partnerDocs = '',
}) {
  const payload = {
    U_U_GYRA_STATUS: statusKey,
    U_U_GYRA_REPORT_ID: String(reportId),
    U_U_GYRA_SEARCH_DATE: searchDate,
  };

  if (partnerDocs) {
    payload[SAP_PARTNER_DOCS_FIELD] = partnerDocs;
  }

  if (statusKey === 'APPROVED') {
    payload.U_dtUltimaAnaliseCredito = searchDate;

    if (approvedCreditLine != null) {
      payload.CreditLine = approvedCreditLine;
    }
  }

  return payload;
}

export async function runGyraSapSync({
  searchMode,
  label,
  dryRun = false,
  searchIntervalDays = null,
  createdFromDate = '',
}) {
  [
    'HANA_SERVER',
    'HANA_PORT',
    'HANA_UID',
    'HANA_PWD',
    'BASE_SAP',
    'COMPANYDB_SAP',
    'SAP_USER',
    'SAP_PASSWORD',
    'GYRA_CLIENT_ID',
    'GYRA_CLIENT_SECRET',
    'GYRA_POLICY_ID',
  ].forEach((name) => requireEnv(name, process.env[name]));

  const delayMs = Number(MOTOR_REQUEST_DELAY_MS || 0);
  const todayStr = formatIsoDateLocal(new Date());
  const resolvedSearchIntervalDays = Number(searchIntervalDays || GYRA_SEARCH_INTERVAL_DAYS || 45);
  const createdFromIso = resolveCreatedFromIso(createdFromDate);

  console.log(`[START] ${label} ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`[INFO] HANA ${HANA_UID}@${HANA_SERVER}:${HANA_PORT}${HANA_SCHEMA ? ` (schema ${HANA_SCHEMA})` : ''}`);
  console.log(`[INFO] SAP Service Layer ${BASE_SAP} (CompanyDB=${COMPANYDB_SAP})`);
  console.log(`[INFO] GYRA ${GYRA_BASE_URL} | policy=${GYRA_POLICY_ID}`);
  console.log(
    searchMode === 'NULL_ONLY'
      ? `[INFO] Filtro OCRD.U_sourcepn='${GYRA_SOURCEPN_VALUE}', CreateDate >= ${createdFromIso} e U_U_GYRA_SEARCH_DATE IS NULL.`
      : `[INFO] Filtro OCRD.U_sourcepn='${GYRA_SOURCEPN_VALUE}', CreateDate >= ${createdFromIso} e U_U_GYRA_SEARCH_DATE com mais de ${resolvedSearchIntervalDays} dia(s).`
  );

  const candidates = await fetchCandidatesFromSap(searchMode, {
    searchIntervalDays: resolvedSearchIntervalDays,
    createdFromDate: createdFromIso,
  });
  console.log(`[INFO] ${candidates.length} registro(s) elegivel(is) no SAP.`);

  if (!candidates.length) return;

  const gyraToken = await requestGyraToken();
  const sap = dryRun ? null : await sapLogin();

  let ok = 0;
  let failed = 0;
  let warned = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const labelText = `${candidate.formattedCnpj} | ${candidate.cardCode}${candidate.cardName ? ` | ${candidate.cardName}` : ''}`;

    try {
      console.log(`-> ${labelText}`);
      const { reportId, report, retriedPending } = await fetchGyraReportWithPendingRetry(gyraToken, candidate.cnpj);
      const statusKey = getGyraStatusKey(report);
      const { creditLine, description } = extractPreApprovedCreditLine(report);
      const partnerDocuments = extractCurrentOwnerDocuments(report, candidate.cnpj, candidate.formattedCnpj);
      const partnerDocs = partnerDocuments.join(',');

      const payload = buildSapUpdatePayload({
        statusKey,
        reportId,
        searchDate: todayStr,
        approvedCreditLine: creditLine,
        partnerDocs,
      });

      if (statusKey === 'APPROVED' && creditLine == null) {
        warned += 1;
        console.warn('   [WARN] APPROVED sem "LIMITE PRE APROVADO" identificado no payload do GYRA.');
      }

      if (dryRun) {
        console.log(`   [DRY-RUN] status=${statusKey} reportId=${reportId} retriedPending=${retriedPending} payload=${JSON.stringify(payload)}`);
        if (description) {
          console.log(`   [DRY-RUN] CreditLine extraido de: ${description}`);
        }
        if (partnerDocs) {
          console.log(`   [DRY-RUN] ${SAP_PARTNER_DOCS_FIELD}=${partnerDocs}`);
        } else {
          console.log(`   [DRY-RUN] ${SAP_PARTNER_DOCS_FIELD} sem socios atuais com CPF identificados.`);
        }
      } else {
        await patchBusinessPartner(sap, candidate.cardCode, payload);
        console.log(`   [OK] status=${statusKey} reportId=${reportId} retriedPending=${retriedPending}`);
        if (description) {
          console.log(`   [OK] CreditLine=${creditLine} extraido de "${description}"`);
        }
        if (partnerDocs) {
          console.log(`   [OK] ${SAP_PARTNER_DOCS_FIELD}=${partnerDocs}`);
        } else {
          console.log(`   [OK] ${SAP_PARTNER_DOCS_FIELD} sem socios atuais com CPF identificados.`);
        }
      }

      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`   [FAIL] ${labelText} -> ${err.response?.data?.error || err.message}`);
    }

    if (delayMs > 0 && index < candidates.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log(`[DONE] ok=${ok} warned=${warned} failed=${failed}`);
}
