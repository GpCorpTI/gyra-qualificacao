// src/utils/reportUtils.js
export function translateStatus(status) {
  const map = {
    APPROVED: 'Aprovado',
    REJECTED: 'Rejeitado',
    ALERT: 'Alerta',
    DENIED: 'Negado',
    PENDING: 'Pendente',
    NOT_EXECUTED: 'Não Processado',
    '': 'Desconhecido',
  };
  return map[status?.toUpperCase()] || status || 'Desconhecido';
}

export function cleanDescription(text) {
  return (text || '').replace(/\{\{.*?\}\}/g, '').trim();
}

export function extractCompanyName(report) {
  const sections = report?.sections || [];
  for (const sec of sections) {
    for (const det of (sec.sectionDetails || [])) {
      const v = det?.values || {};
      if (typeof v.name === 'string' && v.name.trim()) return v.name.trim();
    }
  }
  return '';
}

function normalizeTitle(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function findSummaryItemByTitles(report, titles = []) {
  const wantedTitles = titles.map(normalizeTitle);
  const summary = (report?.sections || []).find((section) => section?.type?.value === 'SUMMARY');

  for (const detail of summary?.sectionDetails || []) {
    for (const value of Object.values(detail?.values || {})) {
      if (value && typeof value === 'object' && wantedTitles.includes(normalizeTitle(value.title))) {
        return value;
      }
    }
  }

  return null;
}

function extractEstimatedBilling(report) {
  const billing = findSummaryItemByTitles(report, [
    'Faturamento estimado',
    'Faturamento presumido',
  ]);

  return billing?.value || '';
}

function findNestedValueByKeys(obj, keys = []) {
  if (!obj || typeof obj !== 'object') return '';

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null && String(obj[key]).trim() !== '') {
      return obj[key];
    }
  }

  for (const value of Object.values(obj)) {
    const found = findNestedValueByKeys(value, keys);
    if (found !== '') return found;
  }

  return '';
}

function extractBasicResponse(report) {
  const basic = (report?.sections || []).find((section) => section?.type?.value === 'BASIC_INFORMATION');

  for (const detail of basic?.sectionDetails || []) {
    if (detail?.values?.response) return detail.values.response;
  }

  return {};
}

function extractCurrentPartners(report) {
  const relations = (report?.sections || []).find((section) => section?.type?.value === 'RELATIONS');
  const sources = [];

  for (const detail of relations?.sectionDetails || []) {
    if (Array.isArray(detail?.values?.relationships)) sources.push(...detail.values.relationships);
    if (Array.isArray(detail?.values?.directDataRelationships)) sources.push(...detail.values.directDataRelationships);
  }

  const seen = new Set();
  return sources
    .filter((partner) => String(partner?.relationshipLevel || partner?.relationshipType || '').toLowerCase().includes('sócio') ||
      String(partner?.relationshipLevel || partner?.relationshipType || '').toLowerCase().includes('socio') ||
      String(partner?.relationshipType || '').toUpperCase() === 'QSA')
    .filter((partner) => {
      const key = `${partner?.name || ''}|${partner?.document || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseCurrencyNumber(value) {
  const normalized = String(value || '0')
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function hasRestrictionFromSummary(report) {
  const pefin = findSummaryItemByTitles(report, ['Pefin']);
  const refin = findSummaryItemByTitles(report, ['Refin']);
  const protestos = findSummaryItemByTitles(report, ['Protestos']);

  return [pefin, refin, protestos].some((item) => parseCurrencyNumber(item?.value) > 0);
}

export function formatDateTime(dt) {
  if (!dt) return '-';

  // Handle ISO, Date, or MySQL "YYYY-MM-DD HH:MM:SS"
  let value = dt;
  if (typeof dt === 'string' && dt.includes(' ') && !dt.includes('T')) {
    value = dt.replace(' ', 'T');
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(dt);

  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function extractReportData(report) {
  const statusKey   = report?.status?.key?.toUpperCase() || '';
  const statusValue = report?.status?.value || 'Sem status';
  const companyName = extractCompanyName(report);
  const clientPhone = report?.clientPhone || '';
  const estimatedBilling = extractEstimatedBilling(report);

  // ✅ Frontend-only override: if pending, show a single risk "Pendente" and hide rules
  if (statusKey === 'PENDING' || statusValue.toLowerCase().includes('pend')) {
    return {
      companyName,
      mainStatus: statusValue || 'Pendente',
      riskInfo: ['Pendente'],
      policySummaries: [],
      clientPhone,
      estimatedBilling,
    };
  }

  // Normal extraction when not pending
  const sections = report?.sections || [];
  const risks = new Set();
  const policySummaries = [];

  sections.forEach(section => {
    (section.sectionDetails || []).forEach(detail => {
      const values = detail.values || {};
      if (values.risk) risks.add(values.risk);

      (values.policyRuleGroupResults || []).forEach(group => {
        (group.policyRuleResultJoins || []).forEach(join => {
          (join.policyRuleResults || []).forEach(rule => {
            const key = rule?.status?.key;
            if (key === 'DENIED' || key === 'ALERT') {
              policySummaries.push({
                description: cleanDescription(rule.descriptions),
                status: rule.status?.value,
              });
            }
          });
        });
      });
    });
  });

  return {
    companyName,
    mainStatus: statusValue,
    riskInfo: Array.from(risks),
    policySummaries,
    clientPhone,
    estimatedBilling,
  };
}

// --- ADD BELOW (reportUtils.js) ---
// utils/reportUtils.js

export function buildQualificacaoClipboardText(report) {
  // ---- helpers (scoped) ----
  const formatarData = (d) => {
    if (!d) return "N/D";
    const dd = new Date(d);
    return dd.toLocaleDateString("pt-BR");
  };

  const limparDescricao = (s) =>
    String(s || "")
      .replace(/\{\{[^}]*\}\}/g, "") // remove {{ ... }}
      .replace(/\s+/g, " ")
      .trim();

  const normalizarMotivo = (s) => {
    const t = String(s || "");
    const low = t.toLowerCase();
    if (low.includes("score bureau") && low.includes("400")) return "Score Bureau menor que 400";
    if (low.includes("sócios com restrição") || low.includes("socios com restricao")) return "Sócio com restrição";
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  };

  const findAll = (obj, key) => {
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(report);
    return out;
  };

  // ---- sections ----
  const sections = report?.sections || [];
  const getSection = (type) => sections.find((s) => s?.type?.value === type);
  const summary   = getSection("SUMMARY");
  const basic     = getSection("BASIC_INFORMATION");
  const relations = getSection("RELATIONS");

  // =================== SCORE / RISCO ===================
  const getSummaryItem = (title) =>
    summary?.sectionDetails?.flatMap((d) => Object.values(d.values || {})).find((v) => v?.title === title);

  const score = getSummaryItem("Score Serasa")?.value || "N/D";
  const risco = report?.status?.value === "REJECTED" ? "Altíssimo" : "Não crítico";
  const telefoneCliente = report?.clientPhone || "";
  const faturamentoEstimado = extractEstimatedBilling(report);

  // =================== DATA ANÁLISE (MOTOR) ===================
  const dataAnaliseMotor =
    report?.values?.createdAt ??
    report?.reportProgress?.finalizedAt ??
    report?.businessDecisions?.policyDecision?.createdAt ??
    null;

  // =================== FUNDAÇÃO / TEMPO ===================
  const dataFundacaoStr =
    basic?.sectionDetails?.find((d) => d?.values?.response)?.values?.response?.dataFundacao;
  const dataFundacao = dataFundacaoStr
    ? new Date(dataFundacaoStr.split(" ")[0].split("/").reverse().join("-"))
    : null;

  let mesesAbertura = "N/D";
  let tempoAberturaTexto = "N/D";
  if (dataFundacao) {
    mesesAbertura = Math.floor((Date.now() - dataFundacao.getTime()) / (1000 * 60 * 60 * 24 * 30));
    const anos = Math.floor(mesesAbertura / 12);
    const meses = mesesAbertura % 12;
    if (anos === 0)       tempoAberturaTexto = `${meses} meses`;
    else if (meses === 0) tempoAberturaTexto = `${anos} anos`;
    else                  tempoAberturaTexto = `${anos} anos e ${meses} meses`;
  }

  // =================== PEFIN / REFIN / PROTESTOS ===================
  const pefin = getSummaryItem("Pefin");
  const pefinValor   = pefin?.value || "R$ 0,00";
  const pefinQtd     = pefin?.subValue || "(0)";
  const pefinRecente = pefin?.resolution || "";

  const refin = getSummaryItem("Refin");
  const refinValor   = refin?.value || "R$ 0,00";
  const refinQtd     = refin?.subValue || "(0)";
  const refinRecente = refin?.resolution || "";

  const protestos = getSummaryItem("Protestos");
  const protestosValor   = protestos?.value || "R$ 0,00";
  const protestosQtd     = protestos?.subValue || "(0)";
  const protestosRecente = protestos?.resolution || "";

  // =================== ALTERAÇÃO DE REGIME ===================
  const taxRegimes =
    basic?.sectionDetails?.flatMap((d) => d?.values?.historyData?.company?.historyTaxRegimes || []);
  let alteracaoRegimeTexto = "Não identificadas";
  if (taxRegimes && taxRegimes.length >= 2) {
    const anterior = taxRegimes[taxRegimes.length - 2];
    const atual    = taxRegimes[taxRegimes.length - 1];
    alteracaoRegimeTexto =
      `${anterior?.taxRegime} > ${atual?.taxRegime} ` +
      `Alteração no regime tributário ${formatarData(atual?.changeDate)}`;
  }

// ===== SÓCIOS (todos) =====
  const sociosRaw =
    relations?.sectionDetails
      ?.flatMap(d => d?.values?.relationships || [])
      ?.filter(r => String(r?.relationshipLevel || '').includes('Sócio')) || [];

  const seenSocios = new Set();
  const socios = [];
  for (const r of sociosRaw) {
    const name = (r?.name || '').trim();
    const doc  = (r?.document || '').trim();
    const key = `${name}|${doc}`;
    if (seenSocios.has(key)) continue;
    seenSocios.add(key);
    socios.push({
      name,
      document: doc,
      since: r?.formattedStartDate || 'N/D',
    });
  }

  // Texto dos sócios para o clipboard
  const sociosTexto = socios.length
    ? socios.map(s =>
        `Nome: ${s.name || 'N/D'}\nCpf: ${s.document || 'N/D'}\nSócio desde: ${s.since}`
      ).join('\n\n')
    : `Nome: N/D\nCpf: N/D\nSócio desde: N/D`;


  // =================== MOTIVOS (SEUS + MOTOR) ===================
  const motivosSet = new Set();

  // seus (mesmos do script)
  const pefinNum = parseFloat((pefinValor || "0").replace(/[^\d,]/g, "").replace(",", "."));
  if (!Number.isNaN(pefinNum) && pefinNum > 0)
    motivosSet.add("Valor total em pefin nos últimos 3 anos maior que 0");

  if (!Number.isNaN(Number(score)) && Number(score) < 400)
    motivosSet.add("Score Bureau menor que 400");

  if (mesesAbertura !== "N/D" && Number.isFinite(mesesAbertura) && mesesAbertura < 11)
    motivosSet.add("Tempo de abertura da empresa em meses menor que 11");

  const protestosNum = parseFloat((protestosValor || "0").replace(/[^\d,]/g, "").replace(",", "."));
  if (!Number.isNaN(protestosNum) && protestosNum > 0)
    motivosSet.add("Valor total em protestos nos últimos 3 anos");

  // do motor (DENIED)
  const groups =
    report?.policyRuleGroupResults ??
    report?.values?.policyRuleGroupResults ??
    report?.businessDecisions?.policyRuleGroupResults ??
    [];
  const groupsFallback = groups.length ? groups : (findAll(report, "policyRuleGroupResults").flat?.() || []);
  const alvo = groupsFallback.filter((g) =>
    (g?.policyRuleGroup?.name || g?.name || "").toLowerCase().includes("motivos reprovação")
  );
  const gruposParaLer = alvo.length ? alvo : groupsFallback;

  for (const g of gruposParaLer) {
    const joins = g?.policyRuleResultJoins || [];
    for (const j of joins) {
      const results = j?.policyRuleResults || [];
      for (const r of results) {
        if (r?.status?.key === "DENIED") {
          const desc = limparDescricao(r?.descriptions || "");
          if (desc) motivosSet.add(normalizarMotivo(desc));
        }
      }
    }
  }

  const motivos = Array.from(motivosSet);

  // =================== TEXTO FINAL (idêntico ao seu script) ===================
  return `
Cadastro Rápido cliente a vista
Vendedor: Marketing

Score: ${score}
Risco: ${risco}
${faturamentoEstimado ? `Faturamento estimado: ${faturamentoEstimado}\n` : ""}
${telefoneCliente ? `Telefone: ${telefoneCliente}\n` : ""}

Fundação: ${formatarData(dataFundacao)} - ${tempoAberturaTexto}
Possui restrição:
Pefin ${pefinValor} ${pefinQtd} ${pefinRecente}
Refin ${refinValor}${refinQtd} ${refinRecente}
Protestos ${protestosValor}${protestosQtd} ${protestosRecente}

Alterações:
${alteracaoRegimeTexto}

Sócios:
${sociosTexto}

Por que ficou à vista?
${motivos.map((m) => `- ${m}`).join("\n")}

Análise realizada pelo motor em: ${formatarData(dataAnaliseMotor)}
`.trim();
}

export function buildAnaliseCreditoCompletaClipboardText(report) {
  const basicResponse = extractBasicResponse(report);
  const score = findSummaryItemByTitles(report, ['Score Serasa'])?.value || 'N/D';
  const risk = findNestedValueByKeys(report, ['risk']) || report?.status?.value || 'N/D';
  const estimatedBilling = extractEstimatedBilling(report) || 'N/D';
  const companyType =
    basicResponse?.naturezaJuridicaDescricao ||
    findNestedValueByKeys(report, ['naturezaJuridicaDescricao']) ||
    'N/D';
  const socialCapital =
    basicResponse?.capitalSocial ||
    findNestedValueByKeys(report, ['capitalSocial', 'capital']) ||
    'N/D';
  const foundationDate = basicResponse?.dataFundacao || findNestedValueByKeys(report, ['dataFundacao']);
  const registrationStatus =
    basicResponse?.situacaoCadastral ||
    findNestedValueByKeys(report, ['situacaoCadastral']) ||
    'N/D';
  const lawsuits = findSummaryItemByTitles(report, ['Processos'])?.value || 'N/D';
  const changes = findSummaryItemByTitles(report, ['Alterações cadastrais', 'Alteracoes cadastrais']);
  const restrictionAnswer = hasRestrictionFromSummary(report) ? 'Sim' : 'Não';
  const partners = extractCurrentPartners(report);
  const partnersText = partners.length
    ? partners.map((partner) => [
        'Qsa:',
        `Nome: ${partner?.name || 'N/D'}`,
        `Cpf: ${partner?.document || 'N/D'}`,
        `Sócio desde: ${partner?.formattedStartDate || partner?.startDate || 'N/D'}`,
        '**Vínculo  com outros cnpjs:**',
      ].join('\n')).join('\n\n')
    : [
        'Qsa:',
        'Nome:',
        'Cpf:',
        'Sócio desde:',
        '**Vínculo  com outros cnpjs:**',
      ].join('\n');

  let companyAge = 'N/D';
  if (foundationDate) {
    const parsed = new Date(String(foundationDate).split(' ')[0].split('/').reverse().join('-'));
    if (!Number.isNaN(parsed.getTime())) {
      const months = Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24 * 30));
      const years = Math.floor(months / 12);
      const remainingMonths = months % 12;
      companyAge = years > 0
        ? `${years} anos${remainingMonths ? ` e ${remainingMonths} meses` : ''}`
        : `${remainingMonths} meses`;
    }
  }

  return `
Cadastro para Análise de Crédito
1. Vendedor Responsável
Nome do Vendedor:
 
2. Análise de Crédito
Score: ${score}
Risco de Crédito: ${risk}
*Tipo de Sociedade:* ${companyType}
**Faturamento Anual:** ${estimatedBilling}
**Capital social: ** ${socialCapital}
Tem restrição? ${restrictionAnswer}
 
**Processos:** ${lawsuits}
Alteração: ${changes?.value ?? 'N/D'}
 
**Tempo de CNPJ: ** ${companyAge}
**Situação Cadastral:** ${registrationStatus}
 
3. Sócios
${partnersText}
 
**Contatos**
`.trim();
}

export function buildClipboardFromReport(report, opts = {}) {
  const { companyName } = extractReportData(report);
  return buildQualificacaoClipboardText({ ...opts, companyName });
}
