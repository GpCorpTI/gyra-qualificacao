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
  SAP_OBSERVATION_FIELD = 'FreeText',
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

function parseFrontendClipboardNumber(value) {
  return parseFloat(String(value || '0').replace(/[^\d,]/g, '').replace(',', '.'));
}

function formatShortDateBR(value) {
  if (!value) return 'N/D';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('pt-BR');
}

function parseFoundationDate(value) {
  if (!value) return null;
  const text = String(value);

  if (/^\d{2}\/\d{2}\/\d{4}/.test(text)) {
    const [day, month, year] = text.slice(0, 10).split('/');
    return new Date(`${year}-${month}-${day}`);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeClipboardReason(text) {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  if (low.includes('score bureau') && low.includes('400')) return 'Score Bureau menor que 400';
  if (low.includes('sócios com restrição') || low.includes('socios com restricao')) return 'Sócio com restrição';
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}

function findAllNestedValuesByKey(obj, key) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
    Object.values(node).forEach(walk);
  };
  walk(obj);
  return out;
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

function findSummaryItemByTitles(report, titles = []) {
  const normalizedTitles = titles.map(normalizePlainText);
  const summary = findSection(report, 'SUMMARY');

  for (const detail of summary?.sectionDetails || []) {
    for (const value of Object.values(detail?.values || {})) {
      if (value && typeof value === 'object' && normalizedTitles.includes(normalizePlainText(value.title))) {
        return value;
      }
    }
  }

  return null;
}

function extractEstimatedBillingForClipboard(report) {
  return findSummaryItemByTitles(report, [
    'Faturamento estimado',
    'Faturamento presumido',
  ])?.value || '';
}

function buildCreditSummaryObservationText(report) {
  const summary = findSection(report, 'SUMMARY');
  const basic = findSection(report, 'BASIC_INFORMATION');
  const relations = findSection(report, 'RELATIONS');

  const getSummaryItem = (title) =>
    summary?.sectionDetails
      ?.flatMap((detail) => Object.values(detail.values || {}))
      .find((value) => value?.title === title);

  const score = getSummaryItem('Score Serasa')?.value || 'N/D';
  const risco = report?.status?.value === 'REJECTED' ? 'Altíssimo' : 'Não crítico';
  const telefoneCliente = report?.clientPhone || '';
  const faturamentoEstimado = extractEstimatedBillingForClipboard(report);

  const dataAnaliseMotor =
    report?.values?.createdAt ??
    report?.reportProgress?.finalizedAt ??
    report?.businessDecisions?.policyDecision?.createdAt ??
    null;

  const dataFundacaoStr =
    basic?.sectionDetails?.find((detail) => detail?.values?.response)?.values?.response?.dataFundacao;
  const dataFundacao = parseFoundationDate(dataFundacaoStr);

  let mesesAbertura = 'N/D';
  let tempoAberturaTexto = 'N/D';
  if (dataFundacao) {
    mesesAbertura = Math.floor((Date.now() - dataFundacao.getTime()) / (1000 * 60 * 60 * 24 * 30));
    const anos = Math.floor(mesesAbertura / 12);
    const meses = mesesAbertura % 12;
    if (anos === 0) tempoAberturaTexto = `${meses} meses`;
    else if (meses === 0) tempoAberturaTexto = `${anos} anos`;
    else tempoAberturaTexto = `${anos} anos e ${meses} meses`;
  }

  const pefin = getSummaryItem('Pefin');
  const pefinValor = pefin?.value || 'R$ 0,00';
  const pefinQtd = pefin?.subValue || '(0)';
  const pefinRecente = pefin?.resolution || '';

  const refin = getSummaryItem('Refin');
  const refinValor = refin?.value || 'R$ 0,00';
  const refinQtd = refin?.subValue || '(0)';
  const refinRecente = refin?.resolution || '';

  const protestos = getSummaryItem('Protestos');
  const protestosValor = protestos?.value || 'R$ 0,00';
  const protestosQtd = protestos?.subValue || '(0)';
  const protestosRecente = protestos?.resolution || '';

  const taxRegimes =
    basic?.sectionDetails?.flatMap((detail) => detail?.values?.historyData?.company?.historyTaxRegimes || []);
  let alteracaoRegimeTexto = 'Não identificadas';
  if (taxRegimes && taxRegimes.length >= 2) {
    const anterior = taxRegimes[taxRegimes.length - 2];
    const atual = taxRegimes[taxRegimes.length - 1];
    alteracaoRegimeTexto =
      `${anterior?.taxRegime} > ${atual?.taxRegime} ` +
      `Alteração no regime tributário ${formatShortDateBR(atual?.changeDate)}`;
  }

  const sociosRaw =
    relations?.sectionDetails
      ?.flatMap((detail) => detail?.values?.relationships || [])
      ?.filter((relationship) => String(relationship?.relationshipLevel || '').includes('Sócio')) || [];

  const seenSocios = new Set();
  const socios = [];
  for (const relationship of sociosRaw) {
    const name = String(relationship?.name || '').trim();
    const doc = String(relationship?.document || '').trim();
    const key = `${name}|${doc}`;
    if (seenSocios.has(key)) continue;
    seenSocios.add(key);
    socios.push({
      name,
      document: doc,
      since: relationship?.formattedStartDate || 'N/D',
    });
  }

  const sociosTexto = socios.length
    ? socios.map((socio) =>
        `Nome: ${socio.name || 'N/D'}\nCpf: ${socio.document || 'N/D'}\nSócio desde: ${socio.since}`
      ).join('\n\n')
    : 'Nome: N/D\nCpf: N/D\nSócio desde: N/D';

  const motivosSet = new Set();
  const pefinNum = parseFrontendClipboardNumber(pefinValor);
  if (!Number.isNaN(pefinNum) && pefinNum > 0) {
    motivosSet.add('Valor total em pefin nos últimos 3 anos maior que 0');
  }

  if (!Number.isNaN(Number(score)) && Number(score) < 400) {
    motivosSet.add('Score Bureau menor que 400');
  }

  if (mesesAbertura !== 'N/D' && Number.isFinite(mesesAbertura) && mesesAbertura < 11) {
    motivosSet.add('Tempo de abertura da empresa em meses menor que 11');
  }

  const protestosNum = parseFrontendClipboardNumber(protestosValor);
  if (!Number.isNaN(protestosNum) && protestosNum > 0) {
    motivosSet.add('Valor total em protestos nos últimos 3 anos');
  }

  const groups =
    report?.policyRuleGroupResults ??
    report?.values?.policyRuleGroupResults ??
    report?.businessDecisions?.policyRuleGroupResults ??
    [];
  const groupsFallback = groups.length ? groups : (findAllNestedValuesByKey(report, 'policyRuleGroupResults').flat?.() || []);
  const targetGroups = groupsFallback.filter((group) =>
    normalizePlainText(group?.policyRuleGroup?.name || group?.name || '').includes('MOTIVOS REPROVACAO')
  );
  const groupsToRead = targetGroups.length ? targetGroups : groupsFallback;

  for (const group of groupsToRead) {
    for (const join of group?.policyRuleResultJoins || []) {
      for (const rule of join?.policyRuleResults || []) {
        if (rule?.status?.key === 'DENIED') {
          const description = cleanDescription(rule?.descriptions || '').replace(/\s+/g, ' ').trim();
          if (description) motivosSet.add(normalizeClipboardReason(description));
        }
      }
    }
  }

  const motivos = Array.from(motivosSet);

  return `
Cadastro Rápido cliente a vista
Vendedor: Marketing

Score: ${score}
Risco: ${risco}
${faturamentoEstimado ? `Faturamento estimado: ${faturamentoEstimado}\n` : ''}${telefoneCliente ? `Telefone: ${telefoneCliente}\n` : ''}

Fundação: ${formatShortDateBR(dataFundacao)} - ${tempoAberturaTexto}
Possui restrição:
Pefin ${pefinValor} ${pefinQtd} ${pefinRecente}
Refin ${refinValor}${refinQtd} ${refinRecente}
Protestos ${protestosValor}${protestosQtd} ${protestosRecente}

Alterações:
${alteracaoRegimeTexto}

Sócios:
${sociosTexto}

Por que ficou à vista?
${motivos.map((motivo) => `- ${motivo}`).join('\n')}

Análise realizada pelo motor em: ${formatShortDateBR(dataAnaliseMotor)}
`.trim();
}

function shouldUpdateSapObservationForStatus(statusFromReport = '') {
  const normalized = normalizePlainText(statusFromReport);
  return normalized === 'APPROVED' || normalized === 'REJECTED';
}

function buildSapObservationBlock({ reportId, text }) {
  const safeReportId = String(reportId || 'sem-report');
  return [
    `[MOTOR_CREDITO:${safeReportId}:INICIO]`,
    text,
    `[MOTOR_CREDITO:${safeReportId}:FIM]`,
  ].join('\n');
}

function mergeSapObservationText(currentValue = '', { reportId, text }) {
  const safeReportId = String(reportId || 'sem-report').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRegex = new RegExp(
    `\\n?\\[MOTOR_CREDITO:${safeReportId}:INICIO\\][\\s\\S]*?\\[MOTOR_CREDITO:${safeReportId}:FIM\\]\\n?`,
    'g'
  );
  const cleanedCurrent = String(currentValue || '').replace(blockRegex, '').trim();
  const nextBlock = buildSapObservationBlock({ reportId, text });

  return cleanedCurrent ? `${cleanedCurrent}\n\n${nextBlock}` : nextBlock;
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
      T1."TaxId0" AS "CNPJ",
      T0."U_sourcepn" AS "SourcePn",
      T0."CreateDate" AS "CreateDate",
      T0."U_U_GYRA_SEARCH_DATE" AS "GyraSearchDate"
    FROM OCRD T0
    JOIN CRD7 T1 ON T1."CardCode" = T0."CardCode"
    WHERE T0."U_sourcepn" = ?
      AND T1."TaxId0" IS NOT NULL
  `;

  if (searchMode === 'NULL_ONLY') {
    return `
      ${baseSelect}
        AND CAST(T0."CreateDate" AS DATE) >= TO_DATE(?, 'YYYY-MM-DD')
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
  return [GYRA_SOURCEPN_VALUE, thresholdIso];
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

async function getBusinessPartnerField(sap, cardCode, fieldName) {
  const response = await sap.get(`/BusinessPartners('${cardCode}')`, {
    params: { $select: fieldName },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GET ${cardCode}.${fieldName} failed (${response.status}): ${JSON.stringify(response.data)}`);
  }

  return response.data?.[fieldName] || '';
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
      : `[INFO] Filtro OCRD.U_sourcepn='${GYRA_SOURCEPN_VALUE}' e U_U_GYRA_SEARCH_DATE com mais de ${resolvedSearchIntervalDays} dia(s).`
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
      const shouldUpdateObservation = shouldUpdateSapObservationForStatus(statusKey);
      const observationText = shouldUpdateObservation ? buildCreditSummaryObservationText(report) : '';

      const payload = buildSapUpdatePayload({
        statusKey,
        reportId,
        searchDate: todayStr,
        approvedCreditLine: creditLine,
        partnerDocs,
      });

      if (shouldUpdateObservation) {
        payload[SAP_OBSERVATION_FIELD] = dryRun
          ? buildSapObservationBlock({ reportId, text: observationText })
          : mergeSapObservationText(
              await getBusinessPartnerField(sap, candidate.cardCode, SAP_OBSERVATION_FIELD),
              { reportId, text: observationText }
            );
      }

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
        if (shouldUpdateObservation) {
          console.log(`   [DRY-RUN] ${SAP_OBSERVATION_FIELD} receberia resumo da analise.`);
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
        if (shouldUpdateObservation) {
          console.log(`   [OK] ${SAP_OBSERVATION_FIELD} atualizado com resumo da analise.`);
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
