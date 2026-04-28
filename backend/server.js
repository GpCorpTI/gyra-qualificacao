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
const MARCI_GYRA_REUSE_DAYS = Number(process.env.MARCI_GYRA_REUSE_DAYS || 45);
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 1200);
const GYRA_HTTP_TIMEOUT_MS = Number(process.env.GYRA_HTTP_TIMEOUT_MS || 30000);
const SAP_TITULOS_PROCEDURE = process.env.SAP_TITULOS_PROCEDURE || '"SBO_GPIMPORTS"."spcGPTitulosEmAberto"';
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

function buildMarciBillingVsCredit(report) {
  const presumedBilling = findSummaryItemByTitle(report, 'Faturamento presumido');
  const creditRecommendation = findSummaryItemByTitle(report, 'Limite recomendado');
  const response = findResponseValues(report);

  const faturamentoPresumido = presumedBilling?.value || 'Nao identificado';
  const faixaFaturamento = response?.faixaFaturamento || 'Nao identificado';
  const limiteRecomendado = creditRecommendation?.value || 'Nao identificado';

  const faturamentoBase = parseCurrencyBR(faturamentoPresumido) ?? estimateBillingFromRange(faixaFaturamento);
  const creditoBase = parseCurrencyBR(limiteRecomendado);
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
    faixaFaturamento: billingVsCredit.faixaFaturamento,
    limiteRecomendado: billingVsCredit.limiteRecomendado,
    faturamentoXCredito: billingVsCredit.descricao,
    percentualCreditoSobreFaturamento: billingVsCredit.percentualCreditoSobreFaturamento,
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
  return { title, value, note, ...extra };
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
      summary.reused ? 'Consulta reaproveitada dentro de 45 dias.' : 'Novo relatorio gerado nesta consulta.'
    ),
    buildMarciCard(
      'Faturamento x credito (GYRA)',
      summary.faturamentoXCredito,
      `Percentual: ${summary.percentualCreditoSobreFaturamento}`
    ),
    buildMarciCard(
      'Faturamento presumido',
      summary.faturamentoPresumido,
      `Faixa: ${summary.faixaFaturamento}`
    ),
    buildMarciCard(
      'Limite recomendado',
      summary.limiteRecomendado,
      `Score Serasa: ${summary.scoreSerasa}`
    ),
    buildMarciCard(
      'Socios atuais',
      summary.sociosAtuaisResumo,
      summary.sociosAtuais?.length
        ? ''
        : 'Sem socios atuais identificados no retorno do Gyra.',
      {
        items: (summary.sociosAtuais || []).map((owner) => ({
          name: owner.nome,
          document: owner.documento || '',
        })),
      }
    ),
  ];

  return cards;
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
    suggestions: [
      `Resuma o Gyra do CNPJ ${summary.cnpj}`,
      `Quais pontos de atencao existem para o CNPJ ${summary.cnpj}?`,
    ],
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
    answer: 'O relatorio ainda esta em analise pelo Gyra. Tente novamente daqui a pouco para obter a leitura completa.',
    sources: ['GYRA'],
    cards: [
      buildMarciCard('Status do relatorio', summary.status || 'PENDING'),
      buildMarciCard('Empresa', summary.companyName || 'Nao identificada', `CNPJ: ${summary.cnpj || 'Nao identificado'}`),
    ],
    suggestions: [
      `Consultar novamente o CNPJ ${summary.cnpj}`,
    ],
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
    'Voce e MARCI, um assistente analitico de credito focado exclusivamente em interpretar retornos reais do GYRA+ e dados financeiros do SAP quando forem fornecidos.',
    'Sua tarefa nao e apenas resumir: voce deve diagnosticar a situacao de credito, interpretar sinais, cruzar evidencias internas do relatorio e apontar oportunidades comerciais ou operacionais quando os dados sustentarem essa leitura.',
    'Analise o payload completo do GYRA+ e o contexto SAP fornecidos pelo backend, tratando os dois como partes da mesma leitura de credito. Responda em portugues do Brasil.',
    'Considere o conjunto completo das informacoes disponiveis, incluindo status, score, risco, regras da politica, alertas, restricoes, faturamento, limite recomendado, socios atuais, titulos em aberto, indicadores SAP, atraso, vencimentos e coerencia entre as fontes.',
    'Sua analise deve priorizar o que realmente importa para decisao de credito: capacidade de pagamento, comportamento financeiro, estabilidade cadastral, risco, alertas de politica, proporcionalidade entre faturamento e limite, pontos de cautela, sinais positivos e qualquer indicio de oportunidade.',
    'Cruze GYRA+ e SAP quando ambos estiverem presentes. Se as fontes apontarem na mesma direcao, diga isso. Se houver conflito, por exemplo boa leitura no GYRA+ mas atraso no SAP, destaque a divergencia e o impacto pratico.',
    'Traga insights praticos: explique o que o dado sugere, por que importa para credito e qual acao comercial ou analitica pode fazer sentido.',
    'Quando houver oportunidade, diferencie oportunidade de credito, oportunidade comercial e oportunidade de acompanhamento. Exemplo: limite conservador frente ao faturamento, cliente com boa leitura mas dados incompletos, necessidade de atualizar cadastro, ou potencial para revisao controlada de limite.',
    'Quando houver risco, seja especifico sobre o motivo: regra acionada, score fraco, restricao, incoerencia, ausencia de dados, limite desproporcional, faturamento incerto ou outro sinal presente no relatorio.',
    'Estruture mentalmente a resposta como: diagnostico geral, sinais positivos, pontos de cautela, oportunidades e encaminhamento recomendado. Nao use markdown; escreva em paragrafos curtos no campo answer.',
    'Nao invente valores, nao conclua aprovacao final, nao crie regras de negocio que nao estejam nos dados e nao diga que viu algo se isso nao estiver presente no retorno.',
    'Se algum dado estiver ausente ou inconclusivo, deixe isso explicito de forma objetiva.',
    'Escreva uma resposta analitica, clara e profissional, como se estivesse apoiando um analista de credito ou comercial a tomar a proxima decisao.',
    'Retorne somente JSON valido, sem markdown, sem comentarios e sem texto fora do JSON.',
    'O JSON deve seguir exatamente esta forma: {"answer":"texto","highlights":["item1"],"warnings":["item1"],"suggestions":["item1","item2"]}.',
    'No campo answer, entregue uma analise de credito integrada com insights e oportunidades, nao um resumo simples nem uma resposta separada por sistemas. Use entre 180 e 320 palavras quando houver dados suficientes.',
    'Em highlights, liste os principais achados e oportunidades sustentadas pelos dados.',
    'Em warnings, liste pontos de cautela ou lacunas relevantes para decisao.',
    'Em suggestions, proponha proximas perguntas uteis ao MARCI, curtas e acionaveis.',
    'Use entre 3 e 6 highlights, entre 0 e 5 warnings e entre 0 e 3 suggestions.',
  ].join(' ');
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
    timeout: 30000,
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

  if (analysis.highlights?.length) {
    nextCards.push(
      buildMarciCard(
        'Leitura executiva',
        analysis.highlights[0],
        analysis.highlights.slice(1).join(' | ')
      )
    );
  }

  if (analysis.warnings?.length) {
    nextCards.push(
      buildMarciCard(
        'Pontos de atencao',
        analysis.warnings[0],
        analysis.warnings.slice(1).join(' | ')
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
    suggestions: analysis.suggestions?.length
      ? analysis.suggestions
      : [
          `Resuma o Gyra do CNPJ ${summary.cnpj}`,
          `Quais pontos de atencao existem para o CNPJ ${summary.cnpj}?`,
        ],
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
      buildMarciCard('Cliente SAP', formatted, 'Consulta SAP indisponivel nesta tentativa.'),
      buildMarciCard('SAP', 'Indisponivel', err?.message || 'Erro ao consultar dados SAP.'),
    ],
    metadata: { cnpj: formatted, cardCode: null },
  });
}

function buildMarciCombinedDeterministicMessage(summary, sapMessage, options = {}) {
  const gyraCards = buildMarciGyraBaseCards(summary);
  const sapCards = sapMessage?.cards || [];
  const isPending = String(summary.status || '').toUpperCase() === 'PENDING';

  return buildMarciMessage({
    intent: 'credit_overview',
    answer: isPending
      ? `O relatorio do GYRA+ ainda esta em analise para ${summary.companyName}. Mesmo assim, ja trouxe os dados objetivos disponiveis do SAP para apoiar a leitura inicial.`
      : [
          `A leitura combinada considera o GYRA+ e os dados SAP disponiveis para ${summary.companyName}.`,
          `No GYRA+, o status esta como ${summary.status}, com risco ${summary.risk}, limite recomendado de ${summary.limiteRecomendado} e relacao faturamento x credito em ${summary.faturamentoXCredito}.`,
          sapMessage?.answer || 'A consulta SAP nao retornou uma leitura textual nesta tentativa.',
        ].join(' '),
    sources: uniqueSources(['GYRA', ...(sapMessage?.sources || [])]),
    cards: [...gyraCards, ...sapCards],
    suggestions: [
      `Quais oportunidades existem para o CNPJ ${summary.cnpj}?`,
      `Quais pontos de cautela existem para o CNPJ ${summary.cnpj}?`,
    ],
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
      suggestions: analysis.suggestions?.length
        ? analysis.suggestions
        : [
            `Quais oportunidades existem para o CNPJ ${summary.cnpj}?`,
            `Quais pontos de cautela existem para o CNPJ ${summary.cnpj}?`,
          ],
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
    `SELECT report_id, created_at, formatted_cnpj
       FROM cnpj_reports
      WHERE normalized_cnpj = ?
        AND created_at > NOW() - INTERVAL ${MARCI_GYRA_REUSE_DAYS} DAY
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalized]
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
    await pool.execute(
      `INSERT INTO cnpj_reports (cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [cnpj, normalized, formatted, reportId, 'MARCI']
    );
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
    const sapUpdate = await maybeUpdateSapUltimaAnaliseCredito({
      statusFromReport: summary.status,
      cnpjForLookup: normalized,
      reportId,
    });
    summary.sapUpdateStatus = sapUpdate.status;
    summary.sapUpdateReason = sapUpdate.reason;
    summary.sapUpdateCardCode = sapUpdate.cardCode;
  } catch (err) {
    logger.warn({ err: err.message, cnpj: summary.cnpj, reportId }, 'marci.sap.update.failed');
    summary.sapUpdateStatus = 'skipped';
    summary.sapUpdateReason = 'SAP_UPDATE_ERROR';
    summary.sapUpdateCardCode = null;
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
        buildMarciCard('CNPJ consultado', formatted),
        buildMarciCard('CardCode', 'Nao encontrado', 'Sem CardCode nao consigo relacionar notas faturadas e grupos no SAP.'),
      ],
      suggestions: [
        `Consultar Gyra do CNPJ ${formatted}`,
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
      ? `Consegui resolver o cliente no SAP pelo CardCode ${cardCode} e executar a procedure spcGPTitulosEmAberto. Trouxe abaixo um recorte inicial do retorno para este cliente.`
      : procedureError
        ? `Consegui resolver o cliente no SAP pelo CardCode ${cardCode}, mas nao consegui executar a procedure spcGPTitulosEmAberto nesta tentativa.`
        : `Consegui resolver o cliente no SAP pelo CardCode ${cardCode}, mas a procedure spcGPTitulosEmAberto nao retornou linhas para este cliente.`,
    sources: ['SAP HANA'],
    cards: [
      buildMarciCard(
        'Cliente SAP',
        formatted,
        `CardCode: ${cardCode}`,
      ),
      buildMarciCard(
        'Indicadores SAP',
        procedureRows.length ? 'Leitura do retorno atual' : 'Sem base para indicadores',
        procedureRows.length
          ? 'Valor mensal soma os saldos com vencimento no mes atual. Percentual em atraso considera a quantidade de notas atrasadas.'
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
                id: 'valor-pago-mes',
                indicador: 'Valor total pago no mes',
                valor: procedureRows.length
                  ? formatSapProcedureCurrency(procedureSummary.currentMonthBalance)
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
        }
      ),
      buildMarciCard(
        'spcGPTitulosEmAberto',
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
        }
      ),
    ],
    suggestions: [
      `Consultar Gyra do CNPJ ${formatted}`,
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

async function maybeUpdateSapUltimaAnaliseCredito({ statusFromReport, cnpjForLookup = '', reportId = null }) {
  const isApproved = String(statusFromReport || '').toUpperCase() === 'APPROVED';
  if (!isApproved) {
    return { status: 'skipped', reason: 'NOT_APPROVED', cardCode: null, dateSet: null };
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
    return { status: 'skipped', reason: 'NO_CNPJ_IN_DB', cardCode: null, dateSet: null };
  }

  const cardCode = await getCardCodeByCNPJ_HANA(resolvedCnpj);
  if (!cardCode) {
    console.warn('CNPJ not found in CRD7.TaxId0; skipping', resolvedCnpj);
    return { status: 'skipped', reason: 'BP_NOT_FOUND_FOR_CNPJ', cardCode: null, dateSet: null };
  }

  const sap = await sapCreateSession();
  const todayStr = new Date().toISOString().slice(0, 10);
  await sapUpdateUltimaAnaliseCredito(sap, cardCode, todayStr);

  console.log(`✅ SAP updated U_dtUltimaAnaliseCredito for ${cardCode} (${resolvedCnpj})`);
  return { status: 'success', reason: null, cardCode, dateSet: todayStr };
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
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();
  const previousYear = currentYear - 1;

  if (!Array.isArray(rows) || !rows.length) {
    return {
      currentMonthBalance: 0,
      currentYearOverdueCount: 0,
      currentYearInvoiceCount: 0,
      currentYearOverduePercent: null,
      previousYearOverdueCount: 0,
      previousYearInvoiceCount: 0,
      previousYearOverduePercent: null,
    };
  }

  let currentMonthBalance = 0;
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

    if (
      vencimento &&
      vencimento.getMonth() === currentMonth &&
      vencimento.getFullYear() === currentYear
    ) {
      currentMonthBalance += saldo;
    }

    if (!vencimento) return;

    const dueYear = vencimento.getFullYear();
    const isOverdue = diferenca != null && diferenca > 0;

    if (dueYear === currentYear) {
      currentYearInvoiceCount += 1;
      if (isOverdue) currentYearOverdueCount += 1;
    }

    if (dueYear === previousYear) {
      previousYearInvoiceCount += 1;
      if (isOverdue) previousYearOverdueCount += 1;
    }
  });

  return {
    currentMonthBalance,
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
    } catch (e) {
      console.error('❌ SAP update failed:', e.message);
      res.set('X-SAP-Update', 'skipped');
      res.set('X-SAP-Reason', 'SAP_UPDATE_ERROR');
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
    });

    if (sapUpdate.status === 'success') {
      return res.json({
        ...sapUpdate,
        reportId,
        companyName: reportRow.business_name || null,
        message: 'SAP atualizado manualmente com sucesso.',
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
      `SELECT id, cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, business_name, status_value, rules, risks, created_at
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
      REGRAS: r.rules,
      RISCOS: r.risks,
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


app.listen(PORT, () => {
  console.log(`✅ Backend API ready at http://localhost:${PORT}`);
});
