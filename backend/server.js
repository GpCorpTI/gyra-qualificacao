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
import { buildAnaliseCreditoCompletaClipboardText } from './lib/credit-observation-text.mjs';



dotenv.config();
const PORT = Number(process.env.PORT);
const GYRA_REPORT_REUSE_DAYS = Number(process.env.GYRA_REPORT_REUSE_DAYS || process.env.MARCI_GYRA_REUSE_DAYS || 45);
const MARCI_GYRA_REUSE_DAYS = GYRA_REPORT_REUSE_DAYS;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 1600);
const ANTHROPIC_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 90000);
const GYRA_HTTP_TIMEOUT_MS = Number(process.env.GYRA_HTTP_TIMEOUT_MS || 30000);
const DEFAULT_GYRA_POLICY_ID = process.env.GYRA_POLICY_ID || '67fd54db0b1b2e14e6e22e19';
const SAP_TITULOS_PROCEDURE = process.env.SAP_TITULOS_PROCEDURE || '"SBO_GPIMPORTS"."spcGPHistTitulosCliente"';
const SAP_PARTNER_DOCS_FIELD = process.env.SAP_PARTNER_DOCS_FIELD || 'U_partnerdocs';
const SAP_OBSERVATION_FIELD = process.env.SAP_OBSERVATION_FIELD || 'FreeText';
const CRM_B1_WEBHOOK_URL = process.env.CRM_B1_WEBHOOK_URL || '';
const CRM_B1_WEBHOOK_TOKEN = process.env.CRM_B1_WEBHOOK_TOKEN || '';
const CRM_B1_CREDIT_ANALYSIS_OPERATION = process.env.CRM_B1_CREDIT_ANALYSIS_OPERATION || 'credit_analysis_date_updated';
const ORDER_RELEASE_POLICY_ID = process.env.ORDER_RELEASE_POLICY_ID || '6a0747892fab8c8353859468';
const ORDER_RELEASE_SECTOR = normalizeReportSectorValue(process.env.ORDER_RELEASE_SECTOR || 'ORDR');
const CRM_B1_ORDER_RELEASE_OPERATION = process.env.CRM_B1_ORDER_RELEASE_OPERATION || 'order_release_credit_check';
const MARCI_REPORT_SECTOR = 'MARCI';
let hasCnpjReportsPolicyId = false;
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

function formatCPFMask(digits11) {
  const s = String(digits11 || '').replace(/\D/g, '');
  if (s.length !== 11) return String(digits11 || '').trim();
  return `${s.slice(0,3)}.${s.slice(3,6)}.${s.slice(6,9)}-${s.slice(9,11)}`;
}

function normalizeReportSectorValue(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  if (text === 'ORDER_RELEASE') return 'ORDR';
  return text.slice(0, 10);
}

function isValidCPFDocument(cpf) {
  const s = String(cpf || '').replace(/\D/g, '');
  return s.length === 11 && !/^(\d)\1{10}$/.test(s);
}

function quoteSapIdentifier(identifier) {
  const clean = String(identifier || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) {
    throw new Error(`Identificador SAP invalido: ${identifier}`);
  }
  return `"${clean}"`;
}

function normalizePlainText(input = '') {
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function isCashOnlyCreditStatus(status = '') {
  const normalized = normalizePlainText(status);
  return (
    normalized.includes('A VISTA') ||
    normalized.includes('REJECTED') ||
    normalized.includes('DENIED') ||
    normalized.includes('NEGADO') ||
    normalized.includes('REPROVADO')
  );
}

function isGyraPendingStatus(statusKey = '', statusValue = '') {
  const key = normalizePlainText(statusKey);
  const value = normalizePlainText(statusValue);
  return key === 'PENDING' || value.includes('PEND');
}

function isGyraApprovedStatus(statusKey = '', statusValue = '') {
  const key = normalizePlainText(statusKey);
  const value = normalizePlainText(statusValue);
  return (
    key === 'APPROVED' ||
    value === 'APPROVED' ||
    value.includes('APROV') ||
    value.includes('LIBERAD')
  );
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

function extractOrderReleaseReasons(report) {
  const { risks, rules } = extractReportSummary(report);
  const reasons = [];
  const seen = new Set();

  const addReason = (reason) => {
    const text = cleanDescription(reason || '').replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    reasons.push(text);
  };

  (rules || []).forEach((rule) => {
    addReason(rule?.status ? `${rule.description} (${rule.status})` : rule?.description);
  });

  (risks || []).forEach((risk) => addReason(`Risco identificado: ${risk}`));

  return reasons.slice(0, 8);
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

async function ensureCnpjReportsPolicyIdColumn() {
  try {
    const columns = await execRows("SHOW COLUMNS FROM cnpj_reports LIKE 'policy_id'");

    if (!columns.length) {
      await pool.execute('ALTER TABLE cnpj_reports ADD COLUMN policy_id VARCHAR(64) NULL AFTER report_id');
      logger.info('cnpj_reports.policy_id column created');
    }

    hasCnpjReportsPolicyId = true;

    await pool.execute(
      `UPDATE cnpj_reports
          SET policy_id = CASE
            WHEN sector = ? THEN ?
            ELSE ?
          END
        WHERE policy_id IS NULL`,
      [ORDER_RELEASE_SECTOR, ORDER_RELEASE_POLICY_ID, DEFAULT_GYRA_POLICY_ID]
    );

    const indexes = await execRows("SHOW INDEX FROM cnpj_reports WHERE Key_name = 'idx_cnpj_policy_sector_created'");

    if (!indexes.length) {
      await pool.execute(
        `ALTER TABLE cnpj_reports
           ADD INDEX idx_cnpj_policy_sector_created
           (normalized_cnpj, policy_id, sector, created_at)`
      );
      logger.info('cnpj_reports context lookup index created');
    }
  } catch (err) {
    hasCnpjReportsPolicyId = false;
    logger.warn(
      { err: err.message },
      'cnpj_reports.policy_id unavailable; report reuse will fall back to sector-only filtering'
    );
  }
}

function buildRecentReportLookupSql({ includePolicy = hasCnpjReportsPolicyId } = {}) {
  const policyFilter = includePolicy ? 'AND policy_id = ?' : '';
  return `
    SELECT id, report_id, formatted_cnpj, created_at
      FROM cnpj_reports
     WHERE normalized_cnpj = ?
       ${policyFilter}
       AND sector <=> ?
       AND created_at > NOW() - INTERVAL ${GYRA_REPORT_REUSE_DAYS} DAY
     ORDER BY created_at DESC
     LIMIT 1`;
}

function buildRecentReportLookupParams({ normalizedCnpj, policyId, sector }) {
  const normalizedSector = normalizeReportSectorValue(sector);
  return hasCnpjReportsPolicyId
    ? [normalizedCnpj, policyId, normalizedSector || null]
    : [normalizedCnpj, normalizedSector || null];
}

async function insertCnpjReport({ cnpj, normalizedCnpj, formattedCnpj, reportId, policyId, sector }) {
  const normalizedSector = normalizeReportSectorValue(sector);

  if (hasCnpjReportsPolicyId) {
    await pool.execute(
      `INSERT INTO cnpj_reports (cnpj, normalized_cnpj, formatted_cnpj, report_id, policy_id, sector, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [cnpj, normalizedCnpj, formattedCnpj, reportId, policyId, normalizedSector || null]
    );
    return;
  }

  await pool.execute(
    `INSERT INTO cnpj_reports (cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [cnpj, normalizedCnpj, formattedCnpj, reportId, normalizedSector || null]
  );
}

function findSection(report, typeValue) {
  return (report?.sections || []).find((section) => section?.type?.value === typeValue) || null;
}

function findSummaryItemByTitle(report, title) {
  const summary = findSection(report, 'SUMMARY');
  for (const detail of summary?.sectionDetails || []) {
    for (const value of Object.values(detail?.values || {})) {
      if (value && typeof value === 'object' && value.title === title) return value;
    }
  }
  return null;
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
  const relatedTo = normalizeCNPJNumeric(relationship?.relatedTo || '');
  const normalizedCompanyDocument = normalizeCNPJNumeric(companyDocument || '');
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
  const companyDocument = formattedCnpj || response?.cnpj || formatCNPJMask(normalizedCnpj) || normalizedCnpj;
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

function buildCurrentOwnersSummary(owners = []) {
  if (!owners.length) return 'Nao identificado';

  return owners
    .map((owner) => owner.documento ? `${owner.nome} - ${owner.documento}` : owner.nome)
    .join(' | ');
}

function extractCurrentOwnerDocuments(report, normalizedCnpj, formattedCnpj) {
  const owners = extractCurrentOwners(report, normalizedCnpj, formattedCnpj);
  const seen = new Set();
  const documents = [];

  owners.forEach((owner) => {
    const digits = normalizeCNPJNumeric(owner?.documento || '');
    if (digits.length !== 11 || seen.has(digits)) return;
    seen.add(digits);
    documents.push(formatCPFMask(digits));
  });

  return documents;
}

function findSummaryItemByTitles(report, titles = []) {
  const wantedTitles = titles.map((title) => normalizePlainText(title));
  const summary = findSection(report, 'SUMMARY');

  for (const detail of summary?.sectionDetails || []) {
    for (const value of Object.values(detail?.values || {})) {
      if (value && typeof value === 'object' && wantedTitles.includes(normalizePlainText(value.title))) {
        return value;
      }
    }
  }

  return null;
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

function extractEstimatedBillingForClipboard(report) {
  return findSummaryItemByTitles(report, [
    'Faturamento estimado',
    'Faturamento presumido',
  ])?.value || '';
}

function buildCreditSummaryObservationText(report) {
  const sections = report?.sections || [];
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

function parseCurrencyBR(value) {
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

function parseMoneyToken(text) {
  if (!text) return null;
  const match = String(text).match(/R\$\s*([\d.,]+)\s*(Mil|MM|Mi|M)?/i);
  if (!match) return null;

  const base = parseCurrencyBR(match[1]);
  if (base == null) return null;

  const unit = (match[2] || '').toUpperCase();
  const multiplier = unit === 'MIL' ? 1_000 : ['MM', 'MI', 'M'].includes(unit) ? 1_000_000 : 1;
  return base * multiplier;
}

function estimateBillingFromRange(rangeText) {
  const text = String(rangeText || '').trim();
  if (!text) return null;

  const matches = Array.from(text.matchAll(/R\$\s*[\d.,]+\s*(?:Mil|MM|Mi|M)?/gi))
    .map((match) => parseMoneyToken(match[0]))
    .filter((value) => value != null);

  if (!matches.length) return null;
  return Math.max(...matches);
}

function formatCurrencyBR(value) {
  if (value == null || Number.isNaN(value)) return 'Nao identificado';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return 'Nao identificado';
  return `${value.toFixed(2).replace('.', ',')}%`;
}

const MARCI_CREDIT_LIMIT_TABLE = [
  { group: 'P P', annualRevenue: 570000, min: 20000, medium: 41171.875, max: 62343.75 },
  { group: 'P P', annualRevenue: 900000, min: 32812.5, medium: 65625, max: 98437.5 },
  { group: 'P P', annualRevenue: 1100000, min: 48125, medium: 88229.16666666666, max: 128333.33333333333 },
  { group: 'P P', annualRevenue: 1350000, min: 59062.5, medium: 108281.25, max: 157500 },
  { group: 'P P', annualRevenue: 1650000, min: 84218.75, medium: 144375, max: 204531.25 },
  { group: 'P P', annualRevenue: 1900000, min: 96979.16666666666, medium: 166250, max: 235520.8333333333 },
  { group: 'M P', annualRevenue: 2150000, min: 106604.16666666666, medium: 182750, max: 258895.8333333333 },
  { group: 'M P', annualRevenue: 2600000, min: 128916.66666666666, medium: 230208.3333333333, max: 331500 },
  { group: 'M P', annualRevenue: 3100000, min: 153708.33333333334, medium: 274479.1666666667, max: 395250 },
  { group: 'M P', annualRevenue: 3400000, min: 168583.33333333334, medium: 301041.6666666667, max: 433500 },
  { group: 'M P', annualRevenue: 3800000, min: 188416.66666666666, medium: 336458.3333333334, max: 484500 },
  { group: 'M P', annualRevenue: 4750000, min: 261250, medium: 424531.25, max: 587812.5 },
  { group: 'M P', annualRevenue: 5250000, min: 288750, medium: 469218.75, max: 649687.5 },
  { group: 'M P', annualRevenue: 5750000, min: 316250, medium: 513906.25, max: 711562.5 },
  { group: 'G P', annualRevenue: 8900000, min: 534000, medium: 801000, max: 1068000 },
  { group: 'G P', annualRevenue: 12125000, min: 727500, medium: 1091250, max: 1455000 },
  { group: 'G P', annualRevenue: 16800000, min: 945000, medium: 1417500, max: 1890000 },
  { group: 'G P', annualRevenue: 21750000, min: 1223437.5, medium: 1861718.75, max: 2500000 },
];

function parseMoneyValue(value) {
  return parseMoneyToken(value) ?? parseCurrencyBR(value);
}

function resolveMarciCreditLimitReference(faturamentoAnual) {
  const annualRevenue = typeof faturamentoAnual === 'number'
    ? faturamentoAnual
    : parseMoneyValue(faturamentoAnual);

  if (!annualRevenue || !Number.isFinite(annualRevenue) || annualRevenue <= 0) return null;

  const sortedTable = [...MARCI_CREDIT_LIMIT_TABLE].sort((a, b) => a.annualRevenue - b.annualRevenue);
  const matchedRow = sortedTable.find((row) => annualRevenue <= row.annualRevenue) || sortedTable[sortedTable.length - 1];
  const isAboveTable = annualRevenue > sortedTable[sortedTable.length - 1].annualRevenue;

  return {
    source: 'Tabela Analise de Credito - MARCI',
    matchRule: isAboveTable ? 'maior_faixa_disponivel' : 'faixa_imediatamente_superior',
    group: matchedRow.group,
    gyraAnnualRevenue: annualRevenue,
    matchedAnnualRevenue: matchedRow.annualRevenue,
    gyraAnnualRevenueFormatted: formatCurrencyBR(annualRevenue),
    matchedAnnualRevenueFormatted: formatCurrencyBR(matchedRow.annualRevenue),
    min: matchedRow.min,
    medium: matchedRow.medium,
    max: matchedRow.max,
    minFormatted: formatCurrencyBR(matchedRow.min),
    mediumFormatted: formatCurrencyBR(matchedRow.medium),
    maxFormatted: formatCurrencyBR(matchedRow.max),
  };
}

function buildMarciBillingVsCredit(report) {
  const presumedBilling = findSummaryItemByTitle(report, 'Faturamento presumido');
  const creditRecommendation = findSummaryItemByTitle(report, 'Limite recomendado');
  const response = findResponseValues(report);

  const faturamentoPresumido = presumedBilling?.value || 'Nao identificado';
  const faixaFaturamento = response?.faixaFaturamento || 'Nao identificado';
  const limiteRecomendado = creditRecommendation?.value || 'Nao identificado';

  const faturamentoBase = parseMoneyValue(faturamentoPresumido) ?? estimateBillingFromRange(faixaFaturamento);
  const creditoBase = parseMoneyValue(limiteRecomendado);
  const percentual = faturamentoBase > 0 && creditoBase != null
    ? (creditoBase / faturamentoBase) * 100
    : null;

  const descricao = percentual != null
    ? `${formatCurrencyBR(creditoBase)} equivale a ${formatPercent(percentual)} do faturamento usado como base`
    : `Faturamento base: ${faturamentoPresumido !== 'Nao identificado' ? faturamentoPresumido : faixaFaturamento} | Limite recomendado: ${limiteRecomendado}`;

  return {
    faturamentoPresumido,
    faixaFaturamento,
    limiteRecomendado,
    faturamentoBase,
    percentualCreditoSobreFaturamento: percentual != null ? formatPercent(percentual) : 'Nao identificado',
    descricao,
  };
}

async function requestGyraToken() {
  const response = await axios.post(
    'https://gyra-core.gyramais.com.br/auth/authenticate',
    {},
    {
      headers: {
        'gyra-client-id': process.env.GYRA_CLIENT_ID,
        'gyra-client-secret': process.env.GYRA_CLIENT_SECRET,
        'Content-Type': 'application/json',
      },
      timeout: GYRA_HTTP_TIMEOUT_MS,
    }
  );

  return response.data.accessToken;
}

async function createGyraReport(token, normalizedCnpj, policyId) {
  const created = await axios.post(
    'https://gyra-core.gyramais.com.br/report',
    { document: normalizedCnpj, policyId },
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: GYRA_HTTP_TIMEOUT_MS,
    }
  );

  return created.data?.id || created.data?.reportId;
}

async function fetchGyraReport(token, reportId) {
  const response = await axios.get(
    `https://gyra-core.gyramais.com.br/report/${reportId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: GYRA_HTTP_TIMEOUT_MS,
    }
  );

  return response.data;
}

function buildMarciGyraSummary(report, { reused, createdAt, reportId, normalizedCnpj, formattedCnpj }) {
  const response = findResponseValues(report);
  const scoreSummary = findSummaryItemByTitle(report, 'Score Serasa');
  const billingVsCredit = buildMarciBillingVsCredit(report);
  const creditLimitReference = resolveMarciCreditLimitReference(billingVsCredit.faturamentoBase);
  const { statusValue, risks } = extractReportSummary(report);
  const currentOwners = extractCurrentOwners(report, normalizedCnpj, formattedCnpj);

  return {
    reportId,
    reused,
    createdAt: createdAt || report?.createdAt || null,
    cnpj: formattedCnpj || response?.cnpj || formatCNPJMask(normalizedCnpj) || normalizedCnpj,
    normalizedCnpj,
    companyName: response?.razaoSocial || extractCompanyName(report) || 'Nao identificado',
    status: statusValue || report?.status?.value || 'Sem status',
    scoreSerasa: scoreSummary?.value || 'Nao identificado',
    risk: risks?.[0] || 'Nao identificado',
    releituraCliente: reused ? 'Sim' : 'Nao',
    faturamentoPresumido: billingVsCredit.faturamentoPresumido,
    faturamentoBase: billingVsCredit.faturamentoBase,
    faixaFaturamento: billingVsCredit.faixaFaturamento,
    limiteRecomendado: billingVsCredit.limiteRecomendado,
    faturamentoXCredito: billingVsCredit.descricao,
    percentualCreditoSobreFaturamento: billingVsCredit.percentualCreditoSobreFaturamento,
    creditLimitReference,
    sociosAtuais: currentOwners,
    sociosAtuaisResumo: buildCurrentOwnersSummary(currentOwners),
  };
}

function normalizeIntentText(input = '') {
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function extractCNPJFromText(input = '') {
  const match = String(input).match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{14}/);
  return match ? normalizeCNPJNumeric(match[0]) : '';
}

function buildMarciCard(title, value, note = '', extra = {}) {
  return {
    title,
    value,
    note,
    category: extra.category || 'Geral',
    tone: extra.tone || 'default',
    ...extra,
  };
}

function buildMarciMessage({
  intent,
  answer,
  sources = [],
  cards = [],
  suggestions = [],
  metadata = {},
}) {
  return {
    intent,
    answer,
    sources,
    cards,
    suggestions,
    metadata: {
      generatedAt: new Date().toISOString(),
      ...metadata,
    },
  };
}

function extractAnthropicTextBlocks(payload) {
  return (payload?.content || [])
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function safeJsonParse(text) {
  if (!text) return null;

  const direct = String(text).trim();
  const candidates = [direct];

  const fenced = direct.match(/```json\s*([\s\S]*?)```/i) || direct.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const jsonBlock = direct.match(/\{[\s\S]*\}$/);
  if (jsonBlock?.[0]) candidates.push(jsonBlock[0].trim());

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // keep trying alternate slices
    }
  }

  return null;
}

function getAnthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
}

function extractAnthropicUsageTotals(usage = {}) {
  const inputTokens = Number(usage?.input_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);
  const cacheCreationInputTokens = Number(usage?.cache_creation_input_tokens || 0);
  const cacheReadInputTokens = Number(usage?.cache_read_input_tokens || 0);

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function buildMarciGyraBaseCards(summary) {
  const cards = [
    buildMarciCard(
      'Releitura do cliente',
      summary.releituraCliente,
      summary.reused ? 'Consulta reaproveitada dentro de 45 dias.' : 'Novo relatorio gerado nesta consulta.',
      { category: 'GYRA+' }
    ),
    buildMarciCard(
      'Faturamento x credito (GYRA)',
      summary.faturamentoXCredito,
      `Percentual: ${summary.percentualCreditoSobreFaturamento}`,
      { category: 'GYRA+' }
    ),
    buildMarciCard(
      'Faturamento presumido',
      summary.faturamentoPresumido,
      `Faixa: ${summary.faixaFaturamento}`,
      { category: 'GYRA+' }
    ),
    buildMarciCard(
      'Limite recomendado',
      summary.limiteRecomendado,
      `Score Serasa: ${summary.scoreSerasa}`,
      { category: 'GYRA+' }
    ),
    buildMarciCard(
      'Socios atuais',
      summary.sociosAtuaisResumo,
      summary.sociosAtuais?.length
        ? ''
        : 'Sem socios atuais identificados no retorno do Gyra.',
      {
        category: 'GYRA+',
        items: (summary.sociosAtuais || []).map((owner) => ({
          name: owner.nome,
          document: owner.documento || '',
        })),
      }
    ),
  ];

  if (summary.creditLimitReference) {
    const limitNote = [
      `Faturamento GYRA: ${summary.creditLimitReference.gyraAnnualRevenueFormatted}`,
      `Faixa: ${summary.creditLimitReference.matchedAnnualRevenueFormatted}`,
      `Grupo: ${summary.creditLimitReference.group}`,
    ].join(' | ');

    cards.push(
      buildMarciCard(
        'Tabela de limites',
        `${summary.creditLimitReference.minFormatted} | ${summary.creditLimitReference.mediumFormatted} | ${summary.creditLimitReference.maxFormatted}`,
        summary.creditLimitReference.matchRule === 'maior_faixa_disponivel'
          ? `${limitNote} | Cliente acima da maior faixa da tabela.`
          : limitNote,
        {
          category: 'Politica interna',
          tone: 'insight',
          emphasis: 'wide',
          table: {
            variant: 'metrics',
            columns: [
              { key: 'label', label: 'Faixa' },
              { key: 'value', label: 'Valor' },
            ],
            rows: [
              { id: 'minimum', label: 'Minimo', value: summary.creditLimitReference.minFormatted },
              { id: 'medium', label: 'Medio', value: summary.creditLimitReference.mediumFormatted },
              { id: 'maximum', label: 'Maximo', value: summary.creditLimitReference.maxFormatted },
            ],
          },
        }
      )
    );
  }

  if (summary.clientPhone) {
    cards.push(
      buildMarciCard(
        'Telefone do cliente',
        summary.clientPhone,
        'Retornado porque o resultado do motor indica atendimento a vista.',
        { category: 'SAP', tone: 'warning' }
      )
    );
  }

  return cards;
}

function buildMarciGyraPendingCards(summary) {
  return [
    buildMarciCard(
      'GYRA+ em processamento',
      'Aguardando conclusao',
      'O relatorio foi localizado ou criado, mas ainda nao terminou de processar no GYRA+.',
      {
        category: 'Status',
        tone: 'pending',
        emphasis: 'wide',
      }
    ),
    buildMarciCard(
      'Consulta registrada',
      summary.companyName || 'Empresa em identificacao',
      `CNPJ: ${summary.cnpj || 'Nao identificado'}${summary.reportId ? ` | Relatorio: ${summary.reportId}` : ''}`,
      {
        category: 'GYRA+',
        tone: 'info',
      }
    ),
    buildMarciCard(
      'Proxima acao',
      'Verificar novamente',
      'Use a sugestao abaixo em alguns instantes. A regra de 45 dias reaproveita o mesmo relatorio quando ele ficar pronto.',
      {
        category: 'Acao',
        tone: 'info',
      }
    ),
  ];
}

function buildMarciGyraDeterministicMessage(summary) {
  return buildMarciMessage({
    intent: 'gyra_summary',
    answer: [
      `Encontrei ${summary.reused ? 'um relatorio reaproveitado' : 'um novo relatorio'} para ${summary.companyName}.`,
      `A leitura principal no Gyra aponta status ${summary.status} com risco ${summary.risk}.`,
      `O limite recomendado esta em ${summary.limiteRecomendado} e a relacao faturamento x credito ficou em ${summary.faturamentoXCredito}.`,
    ].join(' '),
    sources: ['GYRA'],
    cards: buildMarciGyraBaseCards(summary),
    suggestions: [],
    metadata: {
      cnpj: summary.cnpj,
      reportId: summary.reportId,
      reused: summary.reused,
      createdAt: summary.createdAt,
      analysisMode: 'deterministic',
    },
  });
}

function buildMarciGyraPendingMessage(summary) {
  return buildMarciMessage({
    intent: 'gyra_summary',
    answer: 'O GYRA+ ainda esta processando este relatorio. Eu ja deixei a consulta organizada abaixo; em alguns instantes, envie a verificacao novamente para buscar a leitura completa.',
    sources: ['GYRA'],
    cards: buildMarciGyraPendingCards(summary),
    suggestions: [],
    metadata: {
      cnpj: summary.cnpj,
      reportId: summary.reportId,
      reused: summary.reused,
      createdAt: summary.createdAt,
      analysisMode: 'pending',
    },
  });
}

function buildMarciGyraClaudeSystemPrompt() {
  return [
    '<AGENTE_MARCI_CREDITO_MASTER>',
    '<CONTEXTO>',
    'Voce e MARCI, um especialista senior em credito corporativo com atuacao equivalente a um diretor de credito.',
    'Sua funcao e interpretar dados financeiros, cadastrais, comportamentais e de risco provenientes do GYRA+, SAP e politica interna de credito, realizando uma analise integrada, critica e estrategica.',
    'Voce NAO resume dados. Voce NAO descreve payloads. Voce NAO atua como log operacional.',
    'Voce diagnostica risco, interpreta sinais, cruza evidencias, identifica inconsistencias, avalia capacidade financeira e sugere enquadramento de limite conforme politica interna quando a tabela de limites estiver disponivel no contexto.',
    'Sua analise deve refletir pensamento executivo e visao de risco corporativo.',
    '</CONTEXTO>',
    '<OBJETIVO>',
    'Seu objetivo e analisar o cliente de forma integrada, cruzar obrigatoriamente GYRA+ e SAP quando ambos existirem, interpretar comportamento financeiro e qualidade do risco, identificar coerencia entre faturamento, limite e exposicao, enquadrar o cliente na categoria correta de limite quando houver tabela, localizar o valor correspondente na tabela enviada, justificar tecnicamente a categorizacao e apontar riscos, oportunidades e direcionamentos.',
    'A analise deve apoiar tomada de decisao de credito e acompanhamento comercial.',
    '</OBJETIVO>',
    '<FONTES_DADOS>',
    'Considere todas as informacoes disponiveis no payload.',
    'GYRA+: score, status, risco, alertas, regras de politica, restritivos, processos, socios, consultas de mercado, limite recomendado, idade da empresa, CNDs, estrutura fisica, coerencia cadastral, CNAE e alteracoes cadastrais.',
    'SAP: faturamento, titulos em aberto, aging, pontualidade, atrasos, historico de pagamento, comportamento recente, exposicao atual, reincidencia de atraso e concentracao financeira.',
    'POLITICA INTERNA: criterios de categorizacao, tabela de limites, regras impeditivas e criterios qualitativos quando enviados no contexto.',
    'Todas as fontes devem ser tratadas como uma unica leitura de credito. Quando apenas uma fonte estiver disponivel, analise com a fonte existente e declare a limitacao sem transformar isso em log operacional.',
    '</FONTES_DADOS>',
    '<TABELA_LIMITES>',
    'A tabela de limites pode ser enviada dinamicamente no contexto da requisicao. Se ela nao estiver presente, informe categoria_limite e limite_sugerido como "NAO_DISPONIVEL" e explique a limitacao no answer.',
    'Quando houver tabela, ela contem faturamento presumido, faixa minima, faixa media e faixa maxima. Voce deve identificar o faturamento correspondente, localizar a linha correta, definir a categoria adequada (MINIMO, MEDIO ou MAXIMO) e retornar o valor correspondente da tabela.',
    'Nunca invente valores fora da tabela.',
    '</TABELA_LIMITES>',
    '<CRITERIOS_POLITICA>',
    'Critérios indicativos para enquadramento MINIMO: empresa com menor tempo de operacao, score minimo/medio, historico SAP regular, pontualidade acima de 50%, menor robustez financeira, baixa densidade de dados, inconsistencias moderadas e necessidade de postura conservadora.',
    'Critérios indicativos para enquadramento MEDIO: boa leitura geral, estabilidade parcial, historico razoavel, comportamento saudavel com cautelas moderadas e ausencia de robustez suficiente para maximo.',
    'Critérios indicativos para enquadramento MAXIMO: empresa consolidada, mais de 5 anos de operacao, multiplos socios, estrutura robusta, score saudavel, ausencia de restritivos relevantes, ausencia de processos criticos, CNDs emitidas, pontualidade acima de 85%, historico SAP consistente e forte coerencia financeira/operacional.',
    'O enquadramento deve considerar o conjunto completo dos dados e nunca apenas uma variavel isolada.',
    '</CRITERIOS_POLITICA>',
    '<COMPORTAMENTO_ANALITICO>',
    'Voce NAO e um leitor de payload. Voce NAO deve narrar retornos do sistema, etapas tecnicas, procedures, CardCode, ou processamento realizado.',
    'E proibido descrever o processamento, repetir valores sem interpretacao, informar status isoladamente ou narrar retorno bruto do GYRA+ ou SAP.',
    'Toda informacao relevante deve gerar interpretacao: o que significa na pratica, qual impacto no risco, se parece estrutural ou pontual, o que impede evolucao de credito e qual efeito tem sobre enquadramento de limite.',
    'O foco da resposta deve ser leitura critica, qualidade do risco, capacidade financeira, coerencia operacional e sustentacao de credito.',
    'Escreva como um analista senior apresentando conclusao para comite de credito.',
    '</COMPORTAMENTO_ANALITICO>',
    '<REGRA_INTERPRETACAO>',
    'Nao basta citar dados. Sempre explique implicacao, impacto, leitura de risco e consequencia pratica.',
    'Exemplo correto para atraso: o comportamento recente no SAP demonstra deterioracao de pontualidade, reduzindo a confianca operacional e enfraquecendo a sustentacao para expansao de limite.',
    'Exemplo correto para limite zerado: a ausencia de limite recomendado indica que os indicadores atuais nao sustentam exposicao de credito segura, sugerindo necessidade de postura conservadora.',
    '</REGRA_INTERPRETACAO>',
    '<ALERTAS_ESTRUTURAIS>',
    'Alteracoes recentes cadastrais, societarias, operacionais ou financeiras devem sempre ser analisadas como potenciais sinais de alerta, principalmente quando ocorrerem proximas ao momento da analise de credito.',
    'Observe entrada ou saida recente de socios, alteracao de endereco, CNAE, atividade economica, razao social, capital social, administradores, perfil operacional, faturamento, consultas de mercado e inconsistencias entre atividade declarada e operacao percebida.',
    'Esses eventos podem indicar instabilidade operacional, mudanca de perfil financeiro, risco oculto, fragilidade cadastral, transicao societaria, expansao sem sustentacao, potencial fraude ou maquiagem operacional.',
    'Ao identificar alteracao recente, explique impacto potencial, avalie se parece natural ou sensivel, indique necessidade de monitoramento e se reduz confianca para avancar limite.',
    '</ALERTAS_ESTRUTURAIS>',
    '<REGRAS_ANALITICAS>',
    'Sua analise deve responder: existe capacidade real de pagamento; o comportamento financeiro sustenta credito; o risco e compativel com limite atual ou solicitado; existe coerencia entre faturamento, limite e operacao; o SAP confirma ou contradiz o GYRA+; existem sinais ocultos de deterioracao ou oportunidade.',
    'Identifique deterioracao recente, crescimento sem suporte financeiro, uso excessivo de limite, dependencia de excecoes, baixa confiabilidade cadastral, inconsistencia entre fontes, risco estrutural e risco pontual.',
    '</REGRAS_ANALITICAS>',
    '<PESOS_PRIORIZACAO>',
    'PESO CRITICO: inadimplencia, atraso recorrente, SAP deteriorado, restritivos relevantes, processos relevantes e incoerencia financeira.',
    'PESO ALTO: pontualidade, comportamento recente, score, concentracao financeira e estabilidade operacional.',
    'PESO MODERADO: consultas de mercado, tempo de empresa, estrutura fisica, composicao societaria e alteracoes cadastrais recentes.',
    'Se houver conflito entre fontes, explique a divergencia, identifique qual informacao possui maior peso e explique o impacto pratico no risco. GYRA positivo com SAP deteriorado exige cautela; GYRA moderado com SAP consistente pode sustentar enquadramento superior.',
    '</PESOS_PRIORIZACAO>',
    '<REGRAS>',
    'Sempre cruzar GYRA+ e SAP quando ambos existirem. Nunca analisar score isoladamente. Nunca ignorar divergencia entre fontes. Nunca sugerir valor fora da tabela. Nunca inventar informacoes. Nunca concluir aprovacao ou reprovacao final. Se faltar dado relevante, tratar como fator de risco.',
    'A categorizacao deve refletir qualidade do risco e comportamento financeiro. O limite deve respeitar proporcionalidade financeira. Toda conclusao deve possuir sustentacao nos dados. Nunca transformar a resposta em descricao operacional. Nunca repetir payload bruto sem interpretacao. Alteracoes estruturais recentes devem impactar estabilidade e confianca.',
    '</REGRAS>',
    '<ANALISE_OBRIGATORIA>',
    'Sua analise deve conter, dentro do answer: diagnostico integrado do cliente; leitura de risco; consistencia entre GYRA+ e SAP; capacidade financeira; qualidade do comportamento de pagamento; pontos positivos; pontos de cautela; oportunidades de credito; oportunidades comerciais; necessidade de acompanhamento; impacto de alteracoes estruturais recentes; justificativa da categoria escolhida; categoria sugerida; valor sugerido conforme tabela; direcionamento recomendado.',
    '</ANALISE_OBRIGATORIA>',
    '<ESTILO>',
    'Sempre em PT-BR, linguagem executiva, tom analitico e profissional, claro e objetivo, sem floreios, sem repetir dados brutos, foco em interpretacao e direcionamento, postura equivalente a comite de credito.',
    'Nao use markdown no campo answer; escreva em paragrafos curtos.',
    '</ESTILO>',
    '<OUTPUT>',
    'Sempre responda SOMENTE em JSON valido. Nunca envie texto fora do JSON.',
    'Formato obrigatorio: {"categoria_limite":"MINIMO | MEDIO | MAXIMO | NAO_DISPONIVEL","limite_sugerido":"valor encontrado na tabela ou NAO_DISPONIVEL","answer":"analise integrada e justificativa executiva","highlights":["principais pontos positivos ou oportunidades"],"warnings":["principais riscos, divergencias ou cautelas"],"suggestions":["acoes ou perguntas recomendadas"]}.',
    'Regras: answer entre 220 e 450 palavras; highlights entre 3 e 6 itens; warnings entre 0 e 5 itens; suggestions entre 0 e 3 itens.',
    '</OUTPUT>',
    '</AGENTE_MARCI_CREDITO_MASTER>',
  ].join('\n');
}

function buildGyraClaudeContext(summary, fullReport) {
  const { statusValue, risks, rules, businessName } = extractReportSummary(fullReport);
  const responseValues = findResponseValues(fullReport);

  return {
    companyName: businessName || summary.companyName,
    status: statusValue || summary.status,
    risks,
    triggeredPolicyRules: rules,
    responseValues,
    creditLimitReference: summary.creditLimitReference || null,
    summary,
  };
}

async function requestClaudeGyraAnalysis({ userMessage, summary, fullReport, sapContext = null }) {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return null;

  const derivedContext = buildGyraClaudeContext(summary, fullReport);

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: buildMarciGyraClaudeSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: [
            {
              type: 'text',
              text: JSON.stringify({
                userRequest: userMessage,
                source: sapContext ? 'GYRA+SAP' : 'GYRA',
                gyraDerivedContext: derivedContext,
                creditLimitReference: derivedContext.creditLimitReference,
                gyraFullReport: fullReport,
                sapContext,
              }),
            },
          ],
        },
    ],
  };

  const response = await axios.post(ANTHROPIC_API_URL, payload, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    timeout: ANTHROPIC_TIMEOUT_MS,
  });

  const contentText = extractAnthropicTextBlocks(response.data);
  const parsed = safeJsonParse(contentText);

  if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    throw new Error('Claude retornou uma analise sem JSON valido');
  }

  const usage = response.data?.usage || null;
  const usageTotals = extractAnthropicUsageTotals(usage);

  logger.info(
    {
      cnpj: summary?.cnpj,
      reportId: summary?.reportId,
      model: response.data?.model || ANTHROPIC_MODEL,
      ...usageTotals,
    },
    'marci.claude.gyra.usage'
  );

  return {
    answer: parsed.answer.trim(),
    categoriaLimite: typeof parsed.categoria_limite === 'string' ? parsed.categoria_limite.trim() : null,
    limiteSugerido: typeof parsed.limite_sugerido === 'string' ? parsed.limite_sugerido.trim() : null,
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights.filter(Boolean).slice(0, 6) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter(Boolean).slice(0, 5) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(Boolean).slice(0, 3) : [],
    rawText: contentText,
    usage,
    model: response.data?.model || ANTHROPIC_MODEL,
  };
}

function appendClaudeAnalysisCards(cards, analysis) {
  const nextCards = [...cards];

  if (analysis.categoriaLimite && analysis.categoriaLimite !== 'NAO_DISPONIVEL') {
    const recommendedValue = analysis.limiteSugerido && analysis.limiteSugerido !== 'NAO_DISPONIVEL'
      ? analysis.limiteSugerido
      : 'Valor nao disponivel';

    nextCards.push(
      buildMarciCard(
        'Recomendacao MARCI',
        `${analysis.categoriaLimite} - ${recommendedValue}`,
        'Enquadramento sugerido a partir da analise integrada de GYRA+, SAP e politica interna.',
        { category: 'Analise', tone: 'insight', emphasis: 'wide' }
      )
    );
  }

  if (analysis.highlights?.length) {
    nextCards.push(
      buildMarciCard(
        'Leitura executiva',
        analysis.highlights[0],
        analysis.highlights.slice(1).join(' | '),
        { category: 'Analise', tone: 'insight', emphasis: 'wide' }
      )
    );
  }

  if (analysis.warnings?.length) {
    nextCards.push(
      buildMarciCard(
        'Pontos de atencao',
        analysis.warnings[0],
        analysis.warnings.slice(1).join(' | '),
        { category: 'Analise', tone: 'warning', emphasis: 'wide' }
      )
    );
  }

  return nextCards;
}

function buildMarciGyraClaudeMessage(summary, analysis) {
  const cards = appendClaudeAnalysisCards(buildMarciGyraBaseCards(summary), analysis);

  return buildMarciMessage({
    intent: 'gyra_summary',
    answer: analysis.answer,
    sources: ['GYRA', 'Claude'],
    cards,
    suggestions: [],
    metadata: {
      cnpj: summary.cnpj,
      reportId: summary.reportId,
      reused: summary.reused,
      createdAt: summary.createdAt,
      analysisMode: 'claude',
      model: analysis.model,
      inputTokens: analysis.usage?.input_tokens ?? null,
      outputTokens: analysis.usage?.output_tokens ?? null,
      totalTokens: extractAnthropicUsageTotals(analysis.usage).totalTokens,
    },
  });
}

function uniqueSources(sources = []) {
  return [...new Set(sources.filter(Boolean))];
}

function buildSapUnavailableMessage(cnpj, err) {
  const formatted = formatCNPJMask(normalizeCNPJNumeric(cnpj)) || cnpj;

  return buildMarciMessage({
    intent: 'sap_overview',
    answer: `Nao consegui consultar os dados SAP para o CNPJ ${formatted} nesta tentativa.`,
    sources: ['SAP HANA'],
    cards: [
      buildMarciCard('Cliente SAP', formatted, 'Consulta SAP indisponivel nesta tentativa.', {
        category: 'SAP',
        tone: 'warning',
      }),
      buildMarciCard('SAP', 'Indisponivel', err?.message || 'Erro ao consultar dados SAP.', {
        category: 'SAP',
        tone: 'warning',
      }),
    ],
    metadata: { cnpj: formatted, cardCode: null },
  });
}

function buildMarciCombinedDeterministicMessage(summary, sapMessage, options = {}) {
  const isPending = String(summary.status || '').toUpperCase() === 'PENDING';
  const gyraCards = isPending ? buildMarciGyraPendingCards(summary) : buildMarciGyraBaseCards(summary);
  const sapCards = sapMessage?.cards || [];
  const statusText = normalizePlainText(summary.status || '');
  const isHighRiskStatus = statusText.includes('REJECTED') || statusText.includes('A VISTA') || statusText.includes('DENIED') || statusText.includes('NEGADO');
  const hasSapData = Boolean(sapMessage?.metadata?.cardCode) || (sapMessage?.cards || []).some((card) => card?.category === 'SAP');
  const analyticalFallbackAnswer = isPending
    ? `O relatorio do GYRA+ ainda esta em analise para ${summary.companyName}. Enquanto o processamento nao conclui, qualquer decisao de limite deve permanecer em espera, pois a ausencia da leitura completa reduz confianca para avaliar risco, capacidade e politica. Os dados SAP disponiveis podem apoiar uma triagem inicial, mas nao substituem a conclusao do bureau.`
    : [
        `${summary.companyName} apresenta uma leitura de credito que exige postura ${isHighRiskStatus ? 'conservadora' : 'criteriosa'}, considerando o status ${summary.status || 'nao informado'} e risco ${summary.risk || 'nao informado'} no GYRA+.`,
        `A relacao entre faturamento e credito indica ${summary.faturamentoXCredito || 'base insuficiente para proporcao'}, enquanto o limite recomendado de ${summary.limiteRecomendado || 'N/D'} ${isHighRiskStatus ? 'reforca que os indicadores atuais nao sustentam exposicao segura.' : 'deve ser avaliado em conjunto com comportamento e capacidade de pagamento.'}`,
        hasSapData
          ? 'A presenca de dados SAP deve pesar na decisao principalmente pelo comportamento de pagamento, atrasos, reincidencia e titulos em aberto; se houver deterioracao operacional, ela deve prevalecer sobre qualquer leitura isolada de score ou faturamento.'
          : 'A ausencia ou indisponibilidade de dados SAP limita a leitura de capacidade real de pagamento e deve ser tratada como fator de cautela antes de qualquer evolucao de limite.',
        isHighRiskStatus
          ? 'Na pratica, o conjunto sugere que a prioridade deve ser regularizacao, acompanhamento e validacao adicional antes de qualquer concessao de credito.'
          : 'Na pratica, o proximo passo deve ser confirmar consistencia entre limite, faturamento e historico de pagamento antes de expandir exposicao.',
      ].join(' ');

  return buildMarciMessage({
    intent: 'credit_overview',
    answer: analyticalFallbackAnswer,
    sources: uniqueSources(['GYRA', ...(sapMessage?.sources || [])]),
    cards: [...gyraCards, ...sapCards],
    suggestions: [],
    metadata: {
      cnpj: summary.cnpj,
      reportId: summary.reportId,
      reused: summary.reused,
      createdAt: summary.createdAt,
      cardCode: sapMessage?.metadata?.cardCode || null,
      analysisMode: options.analysisMode || 'deterministic_combined',
    },
  });
}

async function buildMarciCombinedCreditResponse({ cnpj, policyId, userMessage }) {
  const { summary, fullReport } = await getMarciGyraSummaryData({ cnpj, policyId, includeFullReport: true });

  let sapMessage;
  try {
    sapMessage = await buildMarciSapOverviewResponse({ cnpj: summary.normalizedCnpj || cnpj });
  } catch (err) {
    logger.warn({ err: err.message, cnpj: summary.cnpj }, 'marci.sap.combined.fallback');
    sapMessage = buildSapUnavailableMessage(summary.cnpj || cnpj, err);
  }

  const deterministic = buildMarciCombinedDeterministicMessage(summary, sapMessage);

  if (String(summary.status || '').toUpperCase() === 'PENDING') {
    return {
      ...deterministic,
      metadata: {
        ...deterministic.metadata,
        analysisMode: 'pending_combined',
      },
    };
  }

  if (!getAnthropicApiKey()) {
    logger.warn({ cnpj: summary.cnpj }, 'marci.claude.combined.not_configured');
    return deterministic;
  }

  try {
    const analysis = await requestClaudeGyraAnalysis({
      userMessage: userMessage || `Analise credito combinando GYRA+ e SAP do CNPJ ${summary.cnpj}`,
      summary,
      fullReport,
      sapContext: {
        answer: sapMessage.answer,
        sources: sapMessage.sources,
        cards: sapMessage.cards,
        metadata: sapMessage.metadata,
      },
    });
    const cards = appendClaudeAnalysisCards(
      [...buildMarciGyraBaseCards(summary), ...(sapMessage.cards || [])],
      analysis
    );

    return buildMarciMessage({
      intent: 'credit_overview',
      answer: analysis.answer,
      sources: uniqueSources(['GYRA', ...(sapMessage.sources || []), 'Claude']),
      cards,
      suggestions: [],
      metadata: {
        cnpj: summary.cnpj,
        reportId: summary.reportId,
        reused: summary.reused,
        createdAt: summary.createdAt,
        cardCode: sapMessage?.metadata?.cardCode || null,
        analysisMode: 'claude_combined',
        model: analysis.model,
        inputTokens: analysis.usage?.input_tokens ?? null,
        outputTokens: analysis.usage?.output_tokens ?? null,
        totalTokens: extractAnthropicUsageTotals(analysis.usage).totalTokens,
      },
    });
  } catch (err) {
    logger.warn({ err: err.message, cnpj: summary.cnpj }, 'marci.claude.combined.fallback');
    return {
      ...deterministic,
      metadata: {
        ...deterministic.metadata,
        analysisMode: 'deterministic_combined_fallback',
      },
    };
  }
}

function detectMarciIntent(message = '') {
  const normalizedText = normalizeIntentText(message);
  const cnpj = extractCNPJFromText(message);

  const asksForHelp =
    !normalizedText ||
    normalizedText.length < 4 ||
    /\b(ajuda|help|marci|o que voce faz|o que vc faz|quem e voce|quem voce e|como funciona|como voce funciona|funcionamento|menu|opcoes|opcoes disponiveis|como usar)\b/.test(normalizedText);
  const talksAboutGyra =
    /\b(gyra|credito|relatorio|releitura|score|risco|faturamento)\b/.test(normalizedText);
  const talksAboutSap =
    /\b(sap|cardcode|historico|pagamento|pagamentos|a vencer|vencido|vencidas|nota|notas|faturada|faturadas|grupo|grupos)\b/.test(normalizedText);

  if (cnpj) {
    return { intent: 'credit_overview', cnpj };
  }

  if (asksForHelp) {
    return { intent: 'help', cnpj };
  }

  if (talksAboutSap) {
    return { intent: 'sap_requires_cnpj', cnpj };
  }

  if (talksAboutGyra) {
    return { intent: 'gyra_requires_cnpj', cnpj };
  }

  return { intent: 'unknown', cnpj };
}

async function getMarciGyraSummaryData({ cnpj, policyId, includeFullReport = false }) {
  const normalized = normalizeCNPJNumeric(cnpj);

  if (!isValidCNPJ(normalized)) {
    const error = new Error('CNPJ invalido');
    error.statusCode = 400;
    throw error;
  }

  if (!policyId) {
    const error = new Error('policyId ausente');
    error.statusCode = 400;
    throw error;
  }

  const formatted = formatCNPJMask(normalized);
  const token = await requestGyraToken();

  const existing = await execRows(
    buildRecentReportLookupSql(),
    buildRecentReportLookupParams({
      normalizedCnpj: normalized,
      policyId,
      sector: MARCI_REPORT_SECTOR,
    })
  );

  let reused = false;
  let reportId;
  let createdAt;

  if (existing.length) {
    reused = true;
    reportId = existing[0].report_id;
    createdAt = existing[0].created_at;
  } else {
    reportId = await createGyraReport(token, normalized, policyId);
    await insertCnpjReport({
      cnpj,
      normalizedCnpj: normalized,
      formattedCnpj: formatted,
      reportId,
      policyId,
      sector: MARCI_REPORT_SECTOR,
    });
    createdAt = new Date().toISOString();
  }

  const fullReport = await fetchGyraReport(token, reportId);
  const summary = buildMarciGyraSummary(fullReport, {
    reused,
    createdAt,
    reportId,
    normalizedCnpj: normalized,
    formattedCnpj: formatted,
  });

  try {
    const partnerDocsUpdate = await maybeUpdateSapPartnerDocsFromGyra({
      fullReport,
      cnpjForLookup: normalized,
      reportId,
    });
    summary.sapPartnerDocsUpdateStatus = partnerDocsUpdate.status;
    summary.sapPartnerDocsUpdateReason = partnerDocsUpdate.reason;
    summary.sapPartnerDocsUpdateCardCodes = partnerDocsUpdate.cardCodes || [];
    summary.sapPartnerDocsUpdatedCount = partnerDocsUpdate.updatedCount || 0;
  } catch (err) {
    logger.warn({ err: err.message, cnpj: summary.cnpj, reportId }, 'marci.sap.partnerdocs.update.failed');
    summary.sapPartnerDocsUpdateStatus = 'skipped';
    summary.sapPartnerDocsUpdateReason = 'SAP_PARTNERDOCS_UPDATE_ERROR';
    summary.sapPartnerDocsUpdateCardCodes = [];
    summary.sapPartnerDocsUpdatedCount = 0;
  }

  try {
    const sapUpdate = await maybeUpdateSapUltimaAnaliseCredito({
      statusFromReport: summary.status,
      cnpjForLookup: normalized,
      reportId,
    });
    summary.sapUpdateStatus = sapUpdate.status;
    summary.sapUpdateReason = sapUpdate.reason;
    summary.sapUpdateCardCode = sapUpdate.cardCode;
    summary.sapUpdateCardCodes = sapUpdate.cardCodes || [];
    summary.sapUpdateUpdatedCount = sapUpdate.updatedCount || 0;
  } catch (err) {
    logger.warn({ err: err.message, cnpj: summary.cnpj, reportId }, 'marci.sap.update.failed');
    summary.sapUpdateStatus = 'skipped';
    summary.sapUpdateReason = 'SAP_UPDATE_ERROR';
    summary.sapUpdateCardCode = null;
    summary.sapUpdateCardCodes = [];
    summary.sapUpdateUpdatedCount = 0;
  }

  if (isCashOnlyCreditStatus(summary.status)) {
    try {
      summary.clientPhone = await getClientPhoneByCNPJ_HANA(normalized);
    } catch (err) {
      logger.warn({ err: err.message, cnpj: summary.cnpj, reportId }, 'marci.sap.phone.lookup.failed');
      summary.clientPhone = null;
    }
  } else {
    summary.clientPhone = null;
  }

  if (includeFullReport) {
    return { summary, fullReport };
  }

  return summary;
}

async function buildMarciGyraChatResponse({ cnpj, policyId, userMessage }) {
  const { summary, fullReport } = await getMarciGyraSummaryData({ cnpj, policyId, includeFullReport: true });
  if (String(summary.status || '').toUpperCase() === 'PENDING') {
    return buildMarciGyraPendingMessage(summary);
  }

  const deterministic = buildMarciGyraDeterministicMessage(summary);

  if (!getAnthropicApiKey()) {
    logger.warn({ cnpj: summary.cnpj }, 'marci.claude.gyra.not_configured');
    return deterministic;
  }

    try {
      const analysis = await requestClaudeGyraAnalysis({
        userMessage: userMessage || `Analise o Gyra do CNPJ ${summary.cnpj}`,
        summary,
        fullReport,
      });
      return buildMarciGyraClaudeMessage(summary, analysis);
  } catch (err) {
    logger.warn({ err: err.message, cnpj: summary.cnpj }, 'marci.claude.gyra.fallback');
    return {
      ...deterministic,
      metadata: {
        ...deterministic.metadata,
        analysisMode: 'deterministic_fallback',
      },
    };
  }
}

async function buildMarciSapOverviewResponse({ cnpj }) {
  const normalized = normalizeCNPJNumeric(cnpj);
  if (!isValidCNPJ(normalized)) {
    const error = new Error('CNPJ invalido');
    error.statusCode = 400;
    throw error;
  }

  const formatted = formatCNPJMask(normalized);
  const cardCode = await getCardCodeByCNPJ_HANA(normalized);

  if (!cardCode) {
    return buildMarciMessage({
      intent: 'sap_overview',
      answer: `Nao encontrei um CardCode no SAP para o CNPJ ${formatted}. O fluxo do MARCI esta pronto para usar esse pivô, mas este cliente ainda nao foi resolvido na base atual.`,
      sources: ['SAP HANA'],
      cards: [
        buildMarciCard('CNPJ consultado', formatted, '', {
          category: 'SAP',
          tone: 'info',
        }),
        buildMarciCard('CardCode', 'Nao encontrado', 'Sem CardCode nao consigo relacionar notas faturadas e grupos no SAP.', {
          category: 'SAP',
          tone: 'warning',
        }),
      ],
      suggestions: [
        `Analisar credito do CNPJ ${formatted}`,
        'Quais consultas o MARCI consegue fazer?',
      ],
      metadata: { cnpj: formatted, cardCode: null },
    });
  }

  let procedureRows = [];
  let procedureError = null;

  try {
    procedureRows = await runSapTitulosProcedure(cardCode);
  } catch (err) {
    procedureError = err;
    logger.warn({ err: err.message, cnpj: formatted, cardCode }, 'marci.sap.procedure.failed');
  }

  const procedureSummary = summarizeSapProcedureRows(procedureRows);

  return buildMarciMessage({
    intent: 'sap_overview',
    answer: procedureRows.length
      ? `Consegui resolver o cliente no SAP pelo CardCode ${cardCode} e executar a procedure spcGPHistTitulosCliente. Trouxe abaixo um recorte inicial do retorno para este cliente.`
      : procedureError
        ? `Consegui resolver o cliente no SAP pelo CardCode ${cardCode}, mas nao consegui executar a procedure spcGPHistTitulosCliente nesta tentativa.`
        : `Consegui resolver o cliente no SAP pelo CardCode ${cardCode}, mas a procedure spcGPHistTitulosCliente nao retornou linhas para este cliente.`,
    sources: ['SAP HANA'],
    cards: [
      buildMarciCard(
        'Cliente SAP',
        formatted,
        `CardCode: ${cardCode}`,
        {
          category: 'SAP',
          tone: 'info',
        }
      ),
      buildMarciCard(
        'Indicadores SAP',
        procedureRows.length ? 'Leitura do retorno atual' : 'Sem base para indicadores',
        procedureRows.length
          ? 'Valor anual soma os saldos com vencimento no ano atual. Percentual em atraso considera a quantidade de notas atrasadas.'
          : 'Os indicadores dependem de linhas retornadas pela procedure.',
        {
          table: {
            variant: 'metrics',
            columns: [
              { key: 'indicador', label: 'Indicador' },
              { key: 'valor', label: 'Valor' },
            ],
            rows: [
              {
                id: 'valor-pago-ano',
                indicador: 'Valor total pago no ano',
                valor: procedureRows.length
                  ? formatSapProcedureCurrency(procedureSummary.currentYearBalance)
                  : '-',
              },
              {
                id: 'percentual-atraso-ano-atual',
                indicador: 'Percentual em atraso ano atual',
                valor: procedureRows.length
                  ? formatSapMetricPercent(procedureSummary.currentYearOverduePercent)
                  : '-',
              },
              {
                id: 'percentual-atraso-ano-passado',
                indicador: 'Percentual em atraso ano passado',
                valor: procedureRows.length
                  ? formatSapMetricPercent(procedureSummary.previousYearOverduePercent)
                  : '-',
              },
            ],
          },
          emphasis: 'wide',
          category: 'SAP',
          tone: procedureRows.length ? 'info' : 'warning',
        }
      ),
      buildMarciCard(
        'spcGPHistTitulosCliente',
        procedureRows.length ? `${procedureRows.length} linha(s) retornada(s)` : 'Sem linhas retornadas',
        procedureError
          ? `Falha na execucao: ${procedureError.message}`
          : procedureRows.length
            ? 'Exibindo no maximo 5 linhas do retorno da procedure.'
            : 'A procedure executou, mas nao retornou dados para este CardCode.',
        {
          table: {
            columns: [
              { key: 'nf', label: 'NF' },
              { key: 'vencimento', label: 'Venc.' },
              { key: 'saldo', label: 'Saldo' },
              { key: 'statusLabel', label: 'Status' },
            ],
            rows: procedureRows.slice(0, 5).map(buildSapProcedureTableRow),
          },
          emphasis: 'wide',
          category: 'SAP',
          tone: procedureError ? 'warning' : 'info',
        }
      ),
    ],
    suggestions: [
      `Analisar credito do CNPJ ${formatted}`,
      `Quero historico de pagamento do CNPJ ${formatted}`,
    ],
    metadata: { cnpj: formatted, cardCode },
  });
}

function buildMarciHelpResponse() {
  return buildMarciMessage({
    intent: 'help',
    answer: 'Eu sou o MARCI, um assistente de analise de credito. Quando voce envia um CNPJ, eu busco os dados disponiveis no GYRA+ e no SAP e transformo tudo em uma leitura unica para apoiar a decisao.',
    sources: [],
    cards: [
      buildMarciCard('Funcao principal', 'Analise de credito', 'Organizo dados externos e historico operacional para entregar uma leitura mais objetiva de risco, limite e contexto do cliente.'),
      buildMarciCard('Fontes de dados', 'GYRA+ e SAP', 'Combino informacoes de bureau, politica de credito, socios, titulos em aberto e indicadores financeiros quando disponiveis.'),
    ],
    suggestions: [
      'Como o MARCI funciona?',
      'Analisar credito do CNPJ 12.345.678/0001-99',
    ],
  });
}

function buildMarciMissingCNPJResponse(intent) {
  const answer = intent === 'sap_requires_cnpj'
    ? 'Para analisar o cliente com apoio do SAP eu preciso de um CNPJ na mensagem.'
    : 'Para consultar o Gyra eu preciso de um CNPJ valido na mensagem.';

  return buildMarciMessage({
    intent,
    answer,
    sources: [],
    suggestions: [
      'Analisar credito do CNPJ 12.345.678/0001-99',
      'Como o MARCI funciona?',
    ],
  });
}

function buildMarciUnknownResponse() {
  return buildMarciMessage({
    intent: 'unknown',
    answer: 'Ainda estou restrito ao fluxo de analise de credito. Envie um CNPJ para eu combinar os dados disponiveis do GYRA+ e do SAP em uma leitura unica.',
    sources: [],
    cards: [
      buildMarciCard('Escopo do MARCI', 'Analise de credito', 'Leitura orientada por dados de GYRA+, SAP e regras internas disponiveis.'),
    ],
    suggestions: [
      'Como o MARCI funciona?',
      'Analisar credito do CNPJ 12.345.678/0001-99',
    ],
  });
}

async function getOrCreateGyraReportForSector({ normalizedCnpj, formattedCnpj, policyId, sector }) {
  const token = await requestGyraToken();
  const existing = await execRows(
    buildRecentReportLookupSql(),
    buildRecentReportLookupParams({ normalizedCnpj, policyId, sector })
  );

  if (existing.length) {
    return {
      token,
      reportId: existing[0].report_id,
      createdAt: existing[0].created_at,
      reused: true,
    };
  }

  const reportId = await createGyraReport(token, normalizedCnpj, policyId);
  await insertCnpjReport({
    cnpj: formattedCnpj || normalizedCnpj,
    normalizedCnpj,
    formattedCnpj,
    reportId,
    policyId,
    sector,
  });

  return {
    token,
    reportId,
    createdAt: new Date().toISOString(),
    reused: false,
  };
}

async function updateStoredReportSummary(reportId, fullReport) {
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

function getOrderReleaseCrmAdditionalInformation({ pending, approved }) {
  if (pending) return 'PENDING';
  return approved ? 'APPROVED' : 'NOT_APPROVED';
}

async function buildOrderReleaseResult({ cnpj, updateCrm = false }) {
  const normalized = normalizeCNPJNumeric(cnpj);

  if (!isValidCNPJ(normalized)) {
    const error = new Error('CNPJ invalido');
    error.statusCode = 400;
    throw error;
  }

  const formatted = formatCNPJMask(normalized);
  const { token, reportId, createdAt, reused } = await getOrCreateGyraReportForSector({
    normalizedCnpj: normalized,
    formattedCnpj: formatted,
    policyId: ORDER_RELEASE_POLICY_ID,
    sector: ORDER_RELEASE_SECTOR,
  });
  const fullReport = await fetchGyraReport(token, reportId);
  const statusKey = String(fullReport?.status?.key || '').toUpperCase();
  const statusValue = fullReport?.status?.value || statusKey || 'Sem status';
  const isPending = isGyraPendingStatus(statusKey, statusValue);
  const approved = isGyraApprovedStatus(statusKey, statusValue);
  const releaseReasons = isPending || approved ? [] : extractOrderReleaseReasons(fullReport);

  if (!isPending) {
    await updateStoredReportSummary(reportId, fullReport);
  }

  let partnerDocsUpdate = { status: 'skipped', reason: isPending ? 'GYRA_PENDING' : 'NOT_EXECUTED' };
  if (!isPending) {
    try {
      partnerDocsUpdate = await maybeUpdateSapPartnerDocsFromGyra({
        fullReport,
        cnpjForLookup: normalized,
        reportId,
      });
    } catch (err) {
      logger.warn({ err: err.message, cnpj: formatted, reportId }, 'order.release.sap.partnerdocs.update.failed');
      partnerDocsUpdate = { status: 'skipped', reason: 'SAP_PARTNERDOCS_UPDATE_ERROR' };
    }
  }

  const cardCode = await getCardCodeByCNPJ_HANA(normalized);
  const shouldUpdateCrm = (approved && !isPending) || updateCrm;
  let crmWebhook = { status: 'skipped', reason: shouldUpdateCrm ? 'CARD_CODE_NOT_FOUND' : 'WAITING_USER_ACTION' };

  if (shouldUpdateCrm && cardCode) {
    crmWebhook = await notifyCrmB1Webhook({
      key: cardCode,
      operation: CRM_B1_ORDER_RELEASE_OPERATION,
      additionalInformation: getOrderReleaseCrmAdditionalInformation({ pending: isPending, approved }),
    });
  }

  return {
    cnpj: formatted,
    reportId,
    reused,
    createdAt,
    companyName: extractCompanyName(fullReport) || 'Nao identificado',
    statusKey,
    statusValue,
    approved,
    pending: isPending,
    releaseReasons,
    releaseReasonSummary: releaseReasons.length
      ? releaseReasons.join(' | ')
      : approved
        ? 'Cliente aprovado pela política de liberação de pedido.'
        : 'Não foram retornados motivos detalhados pela política.',
    cardCode,
    policyId: ORDER_RELEASE_POLICY_ID,
    partnerDocsUpdate,
    crmWebhook,
  };
}

async function executeMarciIntent({ intent, cnpj, policyId, userMessage }) {
  switch (intent) {
    case 'help':
      return buildMarciHelpResponse();
    case 'gyra_requires_cnpj':
    case 'sap_requires_cnpj':
      return buildMarciMissingCNPJResponse(intent);
    case 'gyra_summary':
      return buildMarciGyraChatResponse({ cnpj, policyId, userMessage });
    case 'sap_overview':
      return buildMarciSapOverviewResponse({ cnpj });
    case 'credit_overview':
      return buildMarciCombinedCreditResponse({ cnpj, policyId, userMessage });
    default:
      return buildMarciUnknownResponse();
  }
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

async function sapUpdatePartnerDocs(sap, cardCode, partnerDocs) {
  const resp = await sap.patch(
    `/BusinessPartners('${cardCode}')`,
    { [SAP_PARTNER_DOCS_FIELD]: partnerDocs },
    { headers: { 'If-Match': '*' } }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`SAP PATCH ${SAP_PARTNER_DOCS_FIELD} failed (${resp.status}): ${JSON.stringify(resp.data)}`);
  }
}

function sapBusinessPartnerPath(cardCode) {
  const safeCardCode = String(cardCode || '').replace(/'/g, "''");
  return `/BusinessPartners('${safeCardCode}')`;
}

async function sapGetBusinessPartnerField(sap, cardCode, fieldName) {
  const resp = await sap.get(sapBusinessPartnerPath(cardCode), {
    params: { $select: fieldName },
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`SAP GET ${fieldName} failed (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  return resp.data?.[fieldName] || '';
}

async function sapUpdateBusinessPartnerField(sap, cardCode, fieldName, value) {
  const resp = await sap.patch(
    sapBusinessPartnerPath(cardCode),
    { [fieldName]: value },
    { headers: { 'If-Match': '*' } }
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`SAP PATCH ${fieldName} failed (${resp.status}): ${JSON.stringify(resp.data)}`);
  }
}

async function sapUpdateUltimaAnaliseCreditoForCodes(sap, cardCodes = [], isoDate) {
  const uniqueCardCodes = [...new Set(cardCodes.filter(Boolean))];
  const updated = [];
  const failed = [];

  for (const cardCode of uniqueCardCodes) {
    try {
      await sapUpdateUltimaAnaliseCredito(sap, cardCode, isoDate);
      updated.push(cardCode);
    } catch (err) {
      failed.push({ cardCode, error: err.message });
    }
  }

  return { updated, failed };
}

async function sapUpdatePartnerDocsForCodes(sap, cardCodes = [], partnerDocs) {
  const uniqueCardCodes = [...new Set(cardCodes.filter(Boolean))];
  const updated = [];
  const failed = [];

  for (const cardCode of uniqueCardCodes) {
    try {
      await sapUpdatePartnerDocs(sap, cardCode, partnerDocs);
      updated.push(cardCode);
    } catch (err) {
      failed.push({ cardCode, error: err.message });
    }
  }

  return { updated, failed };
}

async function notifyCrmB1Webhook({ key, operation, additionalInformation = '' }) {
  const normalizedKey = String(key || '').trim();
  const normalizedOperation = String(operation || '').trim();
  const normalizedAdditionalInformation = String(additionalInformation || '');

  if (!CRM_B1_WEBHOOK_URL || !normalizedKey || !normalizedOperation) {
    logger.info(
      {
        configured: Boolean(CRM_B1_WEBHOOK_URL),
        key: normalizedKey || null,
        operation: normalizedOperation || null,
      },
      'crm.b1.webhook.skipped'
    );
    return { status: 'skipped', reason: 'CRM_B1_WEBHOOK_NOT_CONFIGURED' };
  }

  try {
    const url = new URL(CRM_B1_WEBHOOK_URL);
    url.searchParams.set('objtype', '2');
    url.searchParams.set('key', normalizedKey);
    url.searchParams.set('operation', normalizedOperation);
    url.searchParams.set('additional_information', normalizedAdditionalInformation);

    if (CRM_B1_WEBHOOK_TOKEN && !url.searchParams.get('token')) {
      url.searchParams.set('token', CRM_B1_WEBHOOK_TOKEN);
    }

    const response = await axios.post(url.toString(), null, { timeout: 30000 });
    const redactedUrl = new URL(url.toString());
    if (redactedUrl.searchParams.has('token')) {
      redactedUrl.searchParams.set('token', '[REDACTED]');
    }

    logger.info(
      {
        statusCode: response.status,
        key: normalizedKey,
        operation: normalizedOperation,
        additionalInformation: normalizedAdditionalInformation,
        url: redactedUrl.toString(),
      },
      'crm.b1.webhook.success'
    );

    return {
      status: 'success',
      statusCode: response.status,
      operation: normalizedOperation,
      additionalInformation: normalizedAdditionalInformation,
    };
  } catch (err) {
    logger.warn(
      {
        err: err.message,
        statusCode: err.response?.status,
        data: err.response?.data,
        key: normalizedKey,
        operation: normalizedOperation,
        additionalInformation: normalizedAdditionalInformation,
      },
      'crm.b1.webhook.failed'
    );

    return {
      status: 'failed',
      reason: 'CRM_B1_WEBHOOK_ERROR',
      error: err.message,
      statusCode: err.response?.status || null,
    };
  }
}

async function notifyCrmB1CreditAnalysisUpdate({ key, cardCodes = [] }) {
  const relatedCodes = [...new Set(cardCodes.filter(Boolean))];

  if (!relatedCodes.length) {
    return { status: 'skipped', reason: 'NO_RELATED_CARD_CODES' };
  }

  return notifyCrmB1Webhook({
    key,
    operation: CRM_B1_CREDIT_ANALYSIS_OPERATION,
    additionalInformation: relatedCodes.join(','),
  });
}

async function maybeUpdateSapPartnerDocsFromGyra({ fullReport, cnpjForLookup = '', reportId = null }) {
  let resolvedCnpj = String(cnpjForLookup || '').trim();

  if (!resolvedCnpj && reportId) {
    const [cnpjRows] = await pool.execute(
      'SELECT cnpj, normalized_cnpj, formatted_cnpj FROM cnpj_reports WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    resolvedCnpj = String(
      cnpjRows?.[0]?.normalized_cnpj ||
      cnpjRows?.[0]?.cnpj ||
      cnpjRows?.[0]?.formatted_cnpj ||
      ''
    ).trim();
  }

  if (!resolvedCnpj) {
    return { status: 'skipped', reason: 'NO_CNPJ_IN_DB', cardCode: null, cardCodes: [], updatedCount: 0, failed: [], partnerDocs: '' };
  }

  const normalized = normalizeCNPJNumeric(resolvedCnpj);
  const formatted = formatCNPJMask(normalized);
  const partnerDocuments = extractCurrentOwnerDocuments(fullReport, normalized, formatted);

  if (!partnerDocuments.length) {
    return { status: 'skipped', reason: 'NO_CURRENT_OWNER_DOCUMENTS', cardCode: null, cardCodes: [], updatedCount: 0, failed: [], partnerDocs: '' };
  }

  const cardCodes = await getCardCodesByCNPJGroup_HANA(resolvedCnpj);
  const cardCode = cardCodes[0] || null;

  if (!cardCodes.length) {
    return { status: 'skipped', reason: 'BP_NOT_FOUND_FOR_CNPJ', cardCode: null, cardCodes: [], updatedCount: 0, failed: [], partnerDocs: partnerDocuments.join(',') };
  }

  const sap = await sapCreateSession();
  const partnerDocs = partnerDocuments.join(',');
  const updateResult = await sapUpdatePartnerDocsForCodes(sap, cardCodes, partnerDocs);
  const status = updateResult.failed.length
    ? updateResult.updated.length
      ? 'partial'
      : 'failed'
    : 'success';

  logger.info(
    {
      cnpj: resolvedCnpj,
      field: SAP_PARTNER_DOCS_FIELD,
      updated: updateResult.updated.length,
      total: cardCodes.length,
    },
    'sap.partnerdocs.updated'
  );

  return {
    status,
    reason: status === 'success' ? null : 'SAP_PARTNERDOCS_UPDATE_FAILED',
    cardCode,
    cardCodes,
    updatedCardCodes: updateResult.updated,
    updatedCount: updateResult.updated.length,
    failed: updateResult.failed,
    partnerDocs,
  };
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
  const currentText = String(currentValue || '').trim();
  const reportMarker = `[MOTOR_CREDITO:${String(reportId || 'sem-report')}:INICIO]`;
  if (currentText.includes(reportMarker)) return currentText;

  const nextBlock = buildSapObservationBlock({ reportId, text });

  return currentText ? `${currentText}\n\n${nextBlock}` : nextBlock;
}

async function maybeUpdateSapCreditObservationFromGyra({
  fullReport,
  statusFromReport,
  cnpjForLookup = '',
  reportId = null,
}) {
  if (!shouldUpdateSapObservationForStatus(statusFromReport)) {
    return { status: 'skipped', reason: 'STATUS_NOT_FINAL_FOR_OBSERVATION', cardCode: null, cardCodes: [], updatedCount: 0, failed: [] };
  }

  const resolvedCnpj = String(cnpjForLookup || '').trim();
  if (!resolvedCnpj) {
    return { status: 'skipped', reason: 'NO_CNPJ_FOR_OBSERVATION', cardCode: null, cardCodes: [], updatedCount: 0, failed: [] };
  }

  const cardCodes = await getCardCodesByCNPJGroup_HANA(resolvedCnpj);
  const cardCode = cardCodes[0] || null;
  if (!cardCodes.length) {
    return { status: 'skipped', reason: 'BP_NOT_FOUND_FOR_CNPJ', cardCode: null, cardCodes: [], updatedCount: 0, failed: [] };
  }

  const observationText = buildAnaliseCreditoCompletaClipboardText(fullReport);
  const sap = await sapCreateSession();
  const updated = [];
  const failed = [];

  for (const code of [...new Set(cardCodes.filter(Boolean))]) {
    try {
      const currentValue = await sapGetBusinessPartnerField(sap, code, SAP_OBSERVATION_FIELD);
      const nextValue = mergeSapObservationText(currentValue, { reportId, text: observationText });
      await sapUpdateBusinessPartnerField(sap, code, SAP_OBSERVATION_FIELD, nextValue);
      updated.push(code);
    } catch (err) {
      failed.push({ cardCode: code, error: err.message });
    }
  }

  const status = failed.length
    ? updated.length
      ? 'partial'
      : 'failed'
    : 'success';

  logger.info(
    {
      cnpj: resolvedCnpj,
      reportId,
      field: SAP_OBSERVATION_FIELD,
      updated: updated.length,
      total: cardCodes.length,
    },
    'sap.credit.observation.updated'
  );

  return {
    status,
    reason: status === 'success' ? null : 'SAP_OBSERVATION_UPDATE_FAILED',
    field: SAP_OBSERVATION_FIELD,
    cardCode,
    cardCodes,
    updatedCardCodes: updated,
    updatedCount: updated.length,
    failed,
  };
}

async function maybeUpdateSapUltimaAnaliseCredito({ statusFromReport, cnpjForLookup = '', reportId = null, force = false }) {
  const isApproved = String(statusFromReport || '').toUpperCase() === 'APPROVED';
  if (!force && !isApproved) {
    return { status: 'skipped', reason: 'NOT_APPROVED', cardCode: null, cardCodes: [], updatedCount: 0, failed: [], dateSet: null };
  }

  let resolvedCnpj = String(cnpjForLookup || '').trim();

  if (!resolvedCnpj && reportId) {
    const [cnpjRows] = await pool.execute(
      'SELECT cnpj FROM cnpj_reports WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    resolvedCnpj = String(cnpjRows?.[0]?.cnpj || '').trim();
  }

  if (!resolvedCnpj) {
    console.warn('Approved but no CNPJ in DB; skipping SAP update');
    return { status: 'skipped', reason: 'NO_CNPJ_IN_DB', cardCode: null, cardCodes: [], updatedCount: 0, failed: [], dateSet: null };
  }

  const cardCodes = await getCardCodesByCNPJGroup_HANA(resolvedCnpj);
  const cardCode = cardCodes[0] || null;

  if (!cardCodes.length) {
    console.warn('CNPJ not found in CRD7.TaxId0; skipping', resolvedCnpj);
    return { status: 'skipped', reason: 'BP_NOT_FOUND_FOR_CNPJ', cardCode: null, cardCodes: [], updatedCount: 0, failed: [], dateSet: null };
  }

  const sap = await sapCreateSession();
  const todayStr = new Date().toISOString().slice(0, 10);
  const updateResult = await sapUpdateUltimaAnaliseCreditoForCodes(sap, cardCodes, todayStr);
  const status = updateResult.failed.length
    ? updateResult.updated.length
      ? 'partial'
      : 'failed'
    : 'success';

  const crmWebhook = updateResult.updated.length
    ? await notifyCrmB1CreditAnalysisUpdate({
        key: cardCode,
        cardCodes: updateResult.updated,
      })
    : { status: 'skipped', reason: 'NO_SAP_CODES_UPDATED' };

  console.log(`✅ SAP updated U_dtUltimaAnaliseCredito for ${updateResult.updated.length}/${cardCodes.length} code(s) (${resolvedCnpj})`);
  return {
    status,
    reason: status === 'success' ? null : 'SAP_CODES_UPDATE_FAILED',
    cardCode,
    cardCodes,
    updatedCardCodes: updateResult.updated,
    updatedCount: updateResult.updated.length,
    failed: updateResult.failed,
    crmWebhook,
    dateSet: todayStr,
  };
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

async function hanaQueryAll(sql, params = []) {
  const conn = hanaClient.createConnection();
  await new Promise((resolve, reject) =>
    conn.connect(hanaConnParams(), err => (err ? reject(err) : resolve()))
  );

  try {
    const stmt = conn.prepare(sql);
    const rows = await new Promise((resolve, reject) => {
      stmt.exec(params, (err, rs) => (err ? reject(err) : resolve(rs)));
    });
    return Array.isArray(rows) ? rows : [];
  } finally {
    try { conn.disconnect(); } catch (_) {}
  }
}

function unwrapHanaProcedureRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) {
    if (result.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      return result;
    }

    for (const item of result) {
      const rows = unwrapHanaProcedureRows(item);
      if (rows.length) return rows;
    }
  }

  if (result && typeof result === 'object') {
    for (const value of Object.values(result)) {
      const rows = unwrapHanaProcedureRows(value);
      if (rows.length) return rows;
    }
  }

  return [];
}

async function hanaExecute(sql, params = []) {
  const conn = hanaClient.createConnection();
  await new Promise((resolve, reject) =>
    conn.connect(hanaConnParams(), err => (err ? reject(err) : resolve()))
  );

  try {
    const stmt = conn.prepare(sql);
    return await new Promise((resolve, reject) => {
      stmt.exec(params, (err, rs) => (err ? reject(err) : resolve(rs)));
    });
  } finally {
    try { conn.disconnect(); } catch (_) {}
  }
}

async function runSapTitulosProcedure(cardCode) {
  const sql = `CALL ${SAP_TITULOS_PROCEDURE}(?)`;

  try {
    const result = await hanaExecute(sql, [cardCode]);
    return unwrapHanaProcedureRows(result);
  } catch (err) {
    throw new Error(`Falha ao executar ${sql}: ${err.message}`);
  }
}

function findRowValueByHints(row, hints = []) {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.entries(row);

  for (const hint of hints) {
    const match = entries.find(([key]) => key.toLowerCase().includes(hint));
    if (match && match[1] != null && String(match[1]).trim() !== '') {
      return match[1];
    }
  }

  return null;
}

function formatSapProcedureValue(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    return value.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  const text = String(value).trim();
  if (!text) return '';

  const parsedDate = Date.parse(text);
  if (!Number.isNaN(parsedDate) && /[-/T:]/.test(text)) {
    return new Date(parsedDate).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  return text;
}

function formatSapProcedureCurrency(value) {
  if (value == null || value === '') return '-';

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  const raw = String(value).trim();
  if (!raw) return '-';

  const normalized = raw.replace(/[^\d,.-]/g, '');
  if (!normalized || !/\d/.test(normalized)) {
    return formatSapProcedureValue(value);
  }

  const parsed = normalized.includes(',')
    ? Number.parseFloat(normalized.replace(/\./g, '').replace(',', '.'))
    : Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) {
    return formatSapProcedureValue(value);
  }

  return parsed.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseSapProcedureDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const text = String(value).trim();
  if (!text) return null;

  const brDate = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brDate) {
    const [, day, month, year] = brDate;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseSapProcedureInteger(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.replace(/[^\d-]/g, '');
  if (!normalized || normalized === '-') return null;

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSapProcedureStatus(differenceValue) {
  const difference = parseSapProcedureInteger(differenceValue);

  if (difference == null) {
    return { label: '-', tone: 'neutral' };
  }

  if (difference > 0) {
    return {
      label: `${difference} dia(s) em atraso`,
      tone: 'overdue',
    };
  }

  if (difference === 0) {
    return {
      label: 'Vence hoje',
      tone: 'today',
    };
  }

  return {
    label: `A vencer em ${Math.abs(difference)} dia(s)`,
    tone: 'neutral',
  };
}

function formatSapMetricPercent(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(1).replace('.', ',')}%`;
}

function summarizeSapProcedureRows(rows = []) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const previousYear = currentYear - 1;

  if (!Array.isArray(rows) || !rows.length) {
    return {
      currentYearBalance: 0,
      currentYearOverdueCount: 0,
      currentYearInvoiceCount: 0,
      currentYearOverduePercent: null,
      previousYearOverdueCount: 0,
      previousYearInvoiceCount: 0,
      previousYearOverduePercent: null,
    };
  }

  let currentYearBalance = 0;
  let currentYearOverdueCount = 0;
  let currentYearInvoiceCount = 0;
  let previousYearOverdueCount = 0;
  let previousYearInvoiceCount = 0;

  rows.forEach((row) => {
    const saldo = parseCurrencyBR(
      findRowValueByHints(row, ['saldo', 'aberto', 'valor', 'total', 'montante'])
    ) || 0;
    const diferenca = parseSapProcedureInteger(
      findRowValueByHints(row, ['diferenca', 'dias', 'atraso'])
    );
    const vencimento = parseSapProcedureDate(
      findRowValueByHints(row, ['vencimento', 'duedate', 'dataven', 'venc', 'due'])
    );

    if (!vencimento) return;

    const dueYear = vencimento.getFullYear();
    const isOverdue = diferenca != null && diferenca > 0;

    if (dueYear === currentYear) {
      currentYearBalance += saldo;
      currentYearInvoiceCount += 1;
      if (isOverdue) currentYearOverdueCount += 1;
    }

    if (dueYear === previousYear) {
      previousYearInvoiceCount += 1;
      if (isOverdue) previousYearOverdueCount += 1;
    }
  });

  return {
    currentYearBalance,
    currentYearOverdueCount,
    currentYearInvoiceCount,
    currentYearOverduePercent: currentYearInvoiceCount > 0
      ? (currentYearOverdueCount / currentYearInvoiceCount) * 100
      : null,
    previousYearOverdueCount,
    previousYearInvoiceCount,
    previousYearOverduePercent: previousYearInvoiceCount > 0
      ? (previousYearOverdueCount / previousYearInvoiceCount) * 100
      : null,
  };
}

function buildSapProcedureTableRow(row, index) {
  const notaFiscal = findRowValueByHints(row, ['notafiscal', 'invoice', 'documento', 'nota', 'titulo', 'nf', 'docentry']);
  const vencimento = findRowValueByHints(row, ['vencimento', 'duedate', 'dataven', 'venc', 'due']);
  const saldo = findRowValueByHints(row, ['saldo', 'aberto', 'valor', 'total', 'montante']);
  const diferenca = findRowValueByHints(row, ['diferenca', 'dias', 'atraso']);
  const status = buildSapProcedureStatus(diferenca);

  return {
    id: `${formatSapProcedureValue(notaFiscal)}-${formatSapProcedureValue(vencimento)}-${index}`,
    nf: formatSapProcedureValue(notaFiscal) || '-',
    vencimento: formatSapProcedureValue(vencimento) || '-',
    saldo: formatSapProcedureCurrency(saldo),
    statusLabel: status.label,
    statusTone: status.tone,
  };
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

async function getCardCodesByCNPJGroup_HANA(cnpjInput) {
  const digits = normalizeCNPJNumeric(cnpjInput || '');
  if (digits.length !== 14) return [];

  const root = digits.slice(0, 8);
  const normalizeTaxIdSql = `REPLACE(REPLACE(REPLACE(T0."TaxId0", '.', ''), '/', ''), '-', '')`;
  const sql = `
    SELECT
      T0."CardCode",
      ${normalizeTaxIdSql} AS "TaxDigits"
    FROM CRD7 T0
    JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    WHERE T0."TaxId0" IS NOT NULL
      AND LEFT(${normalizeTaxIdSql}, 8) = ?
    ORDER BY
      CASE WHEN ${normalizeTaxIdSql} = ? THEN 0 ELSE 1 END,
      T0."CardCode"
  `;

  const rows = await hanaQueryAll(sql, [root, digits]);
  const cardCodes = rows
    .map((row) => row?.CardCode)
    .filter(Boolean);

  return [...new Set(cardCodes)];
}

function pickSapPhone(row = {}) {
  const phone = row.Phone1 || row.Phone2 || row.Cellular || row.phone1 || row.phone2 || row.cellular;
  return String(phone || '').trim() || null;
}

async function getClientPhoneByCNPJ_HANA(cnpjInput) {
  const digits = normalizeCNPJNumeric(cnpjInput || '');
  if (digits.length !== 14) return null;

  const formatted = formatCNPJMask(digits);
  const normalizeTaxIdSql = `REPLACE(REPLACE(REPLACE(T0."TaxId0", '.', ''), '/', ''), '-', '')`;
  const sql = `
    SELECT
      T1."CardCode",
      T1."Phone1",
      T1."Phone2",
      T1."Cellular"
    FROM CRD7 T0
    JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    WHERE T0."TaxId0" = ?
       OR ${normalizeTaxIdSql} = ?
    ORDER BY
      CASE WHEN T0."TaxId0" = ? THEN 0 ELSE 1 END,
      T1."CardCode"
    LIMIT 1
  `;

  const row = await hanaQueryOne(sql, [formatted, digits, formatted]);
  return pickSapPhone(row);
}

async function getBusinessPartnersByPartnerCpf_HANA(cpfInput) {
  const digits = normalizeCNPJNumeric(cpfInput || '');
  if (!isValidCPFDocument(digits)) return [];

  const partnerDocsField = quoteSapIdentifier(SAP_PARTNER_DOCS_FIELD);
  const normalizePartnerDocsSql = `
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(IFNULL(T1.${partnerDocsField}, ''), '.', ''),
            '-',
            ''
          ),
          '/',
          ''
        ),
        ' ',
        ''
      ),
      ',',
      ''
    )
  `;
  const normalizeTaxIdSql = `REPLACE(REPLACE(REPLACE(IFNULL(T0."TaxId0", ''), '.', ''), '/', ''), '-', '')`;
  const sql = `
    SELECT DISTINCT
      T1."CardCode",
      T1."CardName",
      T1."CardFName",
      T0."TaxId0",
      ${partnerDocsField} AS "PartnerDocs"
    FROM OCRD T1
    LEFT JOIN CRD7 T0 ON T0."CardCode" = T1."CardCode"
    WHERE ${normalizePartnerDocsSql} LIKE ?
    ORDER BY T1."CardCode"
  `;

  const rows = await hanaQueryAll(sql, [`%${digits}%`]);
  return rows.map((row) => {
    const taxDigits = normalizeCNPJNumeric(row?.TaxId0 || '');
    return {
      cardCode: row?.CardCode || '',
      name: row?.CardName || '',
      fantasyName: row?.CardFName || '',
      cnpj: taxDigits.length === 14 ? formatCNPJMask(taxDigits) : (row?.TaxId0 || ''),
      partnerDocs: row?.PartnerDocs || '',
    };
  });
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

// Criação/reativação de Report (normaliza CNPJ e reusa dentro da janela configurada)
app.post('/api/report', async (req, res) => {
  const start = Date.now();
  let reused = false;
  try {
    const { token, cnpj, policyId, sector } = req.body;
    const resolvedPolicyId = policyId || DEFAULT_GYRA_POLICY_ID;
    const resolvedSector = normalizeReportSectorValue(sector);

    const normalized = normalizeCNPJNumeric(cnpj);
    if (!isValidCNPJ(normalized)) {
      return res.status(400).json({ error: 'CNPJ inválido' });
    }
    const formatted = formatCNPJMask(normalized);
    // 1) Verifica se ja existe report recente para o mesmo CNPJ, politica e contexto.
    const exists = await execRows(
      buildRecentReportLookupSql(),
      buildRecentReportLookupParams({
        normalizedCnpj: normalized,
        policyId: resolvedPolicyId,
        sector: resolvedSector,
      })
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
      { document: normalized, policyId: resolvedPolicyId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const reportId = created.data?.id || created.data?.reportId;

    // 3) Insere na base com a politica/contexto usados na consulta.
    await insertCnpjReport({
      cnpj,
      normalizedCnpj: normalized,
      formattedCnpj: formatted,
      reportId,
      policyId: resolvedPolicyId,
      sector: resolvedSector,
    });
    const dur = Date.now() - start;
    req.log.info({ cnpj, sector: resolvedSector, policyId: resolvedPolicyId, reportId, reused, ms: dur }, 'report.create');
    res.json({ id: reportId, reused: false, cnpj: normalized, formatted });

  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'report.create.fail');
    console.error('❌ /api/report:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Report completo + atualização única (ou se estava PENDING)
app.post('/api/marci/gyra-summary', async (req, res) => {
  const start = Date.now();
  try {
    const { cnpj, policyId } = req.body || {};
    const resolvedPolicyId = policyId || process.env.GYRA_POLICY_ID;
    const summary = await getMarciGyraSummaryData({ cnpj, policyId: resolvedPolicyId });

    const dur = Date.now() - start;
    req.log.info({ cnpj: summary.cnpj, reportId: summary.reportId, reused: summary.reused, ms: dur }, 'marci.gyra.summary');
    res.json(summary);
  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'marci.gyra.summary.fail');
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao consultar Gyra no MARCI' });
  }
});

app.post('/api/marci/chat', async (req, res) => {
  const start = Date.now();
  try {
    const { message, history = [], policyId } = req.body || {};
    const resolvedPolicyId = policyId || process.env.GYRA_POLICY_ID;

    if (!String(message || '').trim()) {
      return res.status(400).json({ error: 'Mensagem ausente' });
    }

    const detected = detectMarciIntent(message);
    const response = await executeMarciIntent({
      intent: detected.intent,
      cnpj: detected.cnpj,
      policyId: resolvedPolicyId,
      userMessage: message,
      history,
    });

    const dur = Date.now() - start;
    req.log.info({ intent: response.intent, cnpj: response.metadata?.cnpj, ms: dur }, 'marci.chat');
    res.json({
      message: response,
      router: {
        mode: 'deterministic',
        detectedIntent: detected.intent,
      },
    });
  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'marci.chat.fail');
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao processar a conversa do MARCI' });
  }
});

app.post('/api/order-release', async (req, res) => {
  const start = Date.now();

  try {
    const { cnpj } = req.body || {};
    const result = await buildOrderReleaseResult({ cnpj, updateCrm: false });
    const dur = Date.now() - start;

    req.log.info(
      {
        cnpj: result.cnpj,
        reportId: result.reportId,
        approved: result.approved,
        pending: result.pending,
        crmWebhook: result.crmWebhook?.status,
        ms: dur,
      },
      'order.release.check'
    );

    res.json(result);
  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'order.release.check.fail');
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao consultar liberacao de pedido' });
  }
});

app.post('/api/order-release/update-crm', async (req, res) => {
  const start = Date.now();

  try {
    const { cnpj } = req.body || {};
    const result = await buildOrderReleaseResult({ cnpj, updateCrm: true });
    const dur = Date.now() - start;

    req.log.info(
      {
        cnpj: result.cnpj,
        reportId: result.reportId,
        approved: result.approved,
        pending: result.pending,
        crmWebhook: result.crmWebhook?.status,
        crmReason: result.crmWebhook?.reason,
        ms: dur,
      },
      'order.release.crm.update'
    );

    res.json(result);
  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'order.release.crm.update.fail');
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao atualizar liberacao de pedido no CRM' });
  }
});

app.post('/api/partner-docs/search', async (req, res) => {
  const start = Date.now();

  try {
    const { cpf } = req.body || {};
    const normalizedCpf = normalizeCNPJNumeric(cpf || '');

    if (!isValidCPFDocument(normalizedCpf)) {
      return res.status(400).json({ error: 'CPF invalido' });
    }

    const rows = await getBusinessPartnersByPartnerCpf_HANA(normalizedCpf);
    const dur = Date.now() - start;

    req.log.info(
      {
        cpf: formatCPFMask(normalizedCpf),
        count: rows.length,
        ms: dur,
      },
      'sap.partnerdocs.search'
    );

    res.json({
      cpf: formatCPFMask(normalizedCpf),
      count: rows.length,
      results: rows,
    });
  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, ms: dur }, 'sap.partnerdocs.search.fail');
    res.status(500).json({ error: err.message || 'Erro ao consultar vinculos do CPF no SAP' });
  }
});

app.get('/api/report/:id', async (req, res) => {
  const reportId = req.params.id;
  const start = Date.now();
  let createdAt = null;
  let needsUpdate = false;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing Authorization Bearer token' });

    const reportId = req.params.id;

    // 1) DB: created_at + CNPJ
    const createdRows = await execRows(
      'SELECT created_at, cnpj, normalized_cnpj, formatted_cnpj FROM cnpj_reports WHERE report_id = ? LIMIT 1',
      [reportId]
    );
     createdAt = createdRows?.[0]?.created_at || null;
    const reportCnpjForLookup =
      createdRows?.[0]?.normalized_cnpj ||
      createdRows?.[0]?.cnpj ||
      createdRows?.[0]?.formatted_cnpj ||
      '';

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
    // 4) Update SAP partner CPF field from current Gyra owners.
    try {
      const partnerDocsUpdate = await maybeUpdateSapPartnerDocsFromGyra({
        fullReport,
        cnpjForLookup: reportCnpjForLookup,
        reportId,
      });
      res.set('X-SAP-PartnerDocs-Update', partnerDocsUpdate.status);
      if (partnerDocsUpdate.reason) {
        res.set('X-SAP-PartnerDocs-Reason', partnerDocsUpdate.reason);
      }
      if (partnerDocsUpdate.cardCodes?.length) {
        res.set('X-SAP-PartnerDocs-CardCodes', partnerDocsUpdate.cardCodes.join(','));
        res.set('X-SAP-PartnerDocs-Updated-Count', String(partnerDocsUpdate.updatedCount || 0));
      }
    } catch (e) {
      console.error(`❌ SAP ${SAP_PARTNER_DOCS_FIELD} update failed:`, e.message);
      res.set('X-SAP-PartnerDocs-Update', 'skipped');
      res.set('X-SAP-PartnerDocs-Reason', 'SAP_PARTNERDOCS_UPDATE_ERROR');
    }

    // 5) Resolve final status and optional phone before SAP side effects.
    const statusFromReport = fullReport?.status?.key || fullReport?.status?.value || extractReportSummary(fullReport).statusValue;
    let clientPhone = null;
    if (isCashOnlyCreditStatus(fullReport?.status?.key) || isCashOnlyCreditStatus(statusFromReport)) {
      try {
        clientPhone = await getClientPhoneByCNPJ_HANA(reportCnpjForLookup);
      } catch (e) {
        req.log?.warn?.({ err: e.message, reportId }, 'report.sap.phone.lookup.failed');
      }
    }
    const reportForObservation = { ...fullReport, clientPhone };

    // 6) Update SAP observation for final credit decisions.
    try {
      const observationUpdate = await maybeUpdateSapCreditObservationFromGyra({
        fullReport: reportForObservation,
        statusFromReport,
        cnpjForLookup: reportCnpjForLookup,
        reportId,
      });
      res.set('X-SAP-Observation-Update', observationUpdate.status);
      if (observationUpdate.reason) {
        res.set('X-SAP-Observation-Reason', observationUpdate.reason);
      }
      if (observationUpdate.cardCodes?.length) {
        res.set('X-SAP-Observation-CardCodes', observationUpdate.cardCodes.join(','));
        res.set('X-SAP-Observation-Updated-Count', String(observationUpdate.updatedCount || 0));
      }
    } catch (e) {
      console.error(`❌ SAP ${SAP_OBSERVATION_FIELD} update failed:`, e.message);
      res.set('X-SAP-Observation-Update', 'skipped');
      res.set('X-SAP-Observation-Reason', 'SAP_OBSERVATION_UPDATE_ERROR');
    }

    // 7) Update SAP status if Approved
    try {
      const sapUpdate = await maybeUpdateSapUltimaAnaliseCredito({
        statusFromReport,
        reportId,
      });
      res.set('X-SAP-Update', sapUpdate.status);
      if (sapUpdate.reason) {
        res.set('X-SAP-Reason', sapUpdate.reason);
      }
      if (sapUpdate.cardCode) {
        res.set('X-SAP-CardCode', sapUpdate.cardCode);
      }
      if (sapUpdate.cardCodes?.length) {
        res.set('X-SAP-CardCodes', sapUpdate.cardCodes.join(','));
        res.set('X-SAP-Updated-Count', String(sapUpdate.updatedCount || 0));
      }
    } catch (e) {
      console.error('❌ SAP update failed:', e.message);
      res.set('X-SAP-Update', 'skipped');
      res.set('X-SAP-Reason', 'SAP_UPDATE_ERROR');
    }
      
    // 8) Return Gyra data + our DB timestamp
    const dur = Date.now() - start;
    req.log.info({ reportId, createdAt, updated: needsUpdate, ms: dur }, 'report.fetch');
    res.json({...fullReport, createdAt, clientPhone });

  } catch (err) {
    const dur = Date.now() - start;
    req.log.error({ err: err.message, reportId, createdAt, updated: needsUpdate, ms: dur }, 'report.fetch.fail');
    console.error('❌ /api/report/:id:', err.response?.data || err.message || err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

app.post('/api/report/:id/update-sap-manual', async (req, res) => {
  const reportId = req.params.id;

  try {
    const rows = await execRows(
      `SELECT cnpj, business_name, status_value
       FROM cnpj_reports
       WHERE report_id = ?
       LIMIT 1`,
      [reportId]
    );

    const reportRow = rows?.[0];
    if (!reportRow) {
      return res.status(404).json({
        status: 'skipped',
        reason: 'REPORT_NOT_FOUND',
        message: 'Nao encontrei a ultima consulta para atualizar o SAP manualmente.',
      });
    }

    const sapUpdate = await maybeUpdateSapUltimaAnaliseCredito({
      statusFromReport: reportRow.status_value,
      cnpjForLookup: reportRow.cnpj,
      reportId,
      force: true,
    });

    if (sapUpdate.status === 'success' || sapUpdate.status === 'partial') {
      return res.json({
        ...sapUpdate,
        reportId,
        companyName: reportRow.business_name || null,
        message: sapUpdate.status === 'partial'
          ? `SAP atualizado parcialmente: ${sapUpdate.updatedCount || 0} codigo(s) atualizado(s), com falha em ${sapUpdate.failed?.length || 0}.`
          : `SAP atualizado manualmente com sucesso em ${sapUpdate.updatedCount || 0} codigo(s).`,
      });
    }

    return res.json({
      ...sapUpdate,
      reportId,
      companyName: reportRow.business_name || null,
      message: sapUpdate.reason === 'NOT_APPROVED'
        ? 'O cliente da ultima consulta ainda nao esta aprovado no motor.'
        : 'Nao foi possivel atualizar o SAP com os dados da ultima consulta.',
    });
  } catch (err) {
    req.log?.error?.({ err: err.message, reportId }, 'report.sap.manual.fail');
    return res.status(500).json({
      status: 'skipped',
      reason: 'SAP_UPDATE_ERROR',
      message: err.message || 'Erro interno ao atualizar o SAP manualmente.',
    });
  }
});

// Lista dentro da janela configurada
app.get('/api/reports', async (req, res) => {
  try {
    const policyIdSelect = hasCnpjReportsPolicyId ? 'policy_id,' : 'NULL AS policy_id,';
    const rows = await execRows(
      `SELECT
         id,
         cnpj,
         normalized_cnpj,
         formatted_cnpj,
         report_id,
         ${policyIdSelect}
         sector,
         business_name,
         status_value,
         risks,
         rules,
         created_at
       FROM cnpj_reports
       WHERE created_at > NOW() - INTERVAL ${GYRA_REPORT_REUSE_DAYS} DAY
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/reports:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export XLSX dentro da janela configurada
app.get('/api/reports.xlsx', async (req, res) => {
  try {
    const policyIdSelect = hasCnpjReportsPolicyId ? 'policy_id,' : 'NULL AS policy_id,';
    const [rows] = await pool.execute(
      `SELECT id, cnpj, normalized_cnpj, formatted_cnpj, report_id, ${policyIdSelect} sector, business_name, status_value, rules, risks, created_at
         FROM cnpj_reports
        WHERE created_at > NOW() - INTERVAL ${GYRA_REPORT_REUSE_DAYS} DAY
        ORDER BY created_at DESC`
    );

    const data = rows.map((r) => ({
      ID: r.id,
      CNPJ_ORIGINAL: r.cnpj,
      CNPJ_NORMALIZADO: r.normalized_cnpj,
      CNPJ_FORMATADO: r.formatted_cnpj, // ✅ incluído
      REPORT_ID: r.report_id,
      POLITICA: r.policy_id,
      SETOR: r.sector,
      NOME_EMPRESA: r.business_name,
      STATUS_GERAL: r.status_value,
      REGRAS: r.rules,
      RISCOS: r.risks,
      CRIADO_EM: r.created_at,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, `reports_${GYRA_REPORT_REUSE_DAYS}d`);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="reports.xlsx"');
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

// Redirect root to the SPA base path
app.get('/', (_req, res) => {
  res.redirect('/motorcredito/');
});

// Serve static files under /motorcredito
app.use(
  '/motorcredito',
  express.static(distPath, {
    maxAge: '7d',
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    },
  })
);

// SPA fallback for any /motorcredito/* route
app.get('/motorcredito/*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(distPath, 'index.html'));
});


async function startServer() {
  await ensureCnpjReportsPolicyIdColumn();

  app.listen(PORT, () => {
    console.log(`✅ Backend API ready at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error({ err: err.message }, 'backend.start.fail');
  process.exit(1);
});
