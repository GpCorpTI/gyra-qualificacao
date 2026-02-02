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

  // ✅ Frontend-only override: if pending, show a single risk "Pendente" and hide rules
  if (statusKey === 'PENDING' || statusValue.toLowerCase().includes('pend')) {
    return {
      companyName,
      mainStatus: statusValue || 'Pendente',
      riskInfo: ['Pendente'],
      policySummaries: [],
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
  };
}

// --- ADD BELOW (reportUtils.js) ---
// utils/reportUtils.js

export function buildQualificacaoClipboardText(report) {
  // ----- tiny helpers (scoped) -----
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
    const low = s.toLowerCase();
    if (low.includes("score bureau") && low.includes("400")) return "Score Bureau menor que 400";
    if (low.includes("sócios com restrição") || low.includes("socios com restricao")) return "Sócio com restrição";
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const findAll = (obj, key) => {
    const res = [];
    if (!obj || typeof obj !== "object") return res;
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(obj[key]);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object") res.push(...findAll(v, key));
    }
    return res;
  };

  // ----- sections -----
  const sections = report?.sections || [];
  const getSection = (type) => sections.find((s) => s?.type?.value === type);
  const summary = getSection("SUMMARY");
  const basic = getSection("BASIC_INFORMATION");
  const relations = getSection("RELATIONS");

  // ===== SCORE / RISCO (texto padrão usa “Altíssimo” quando REJECTED) =====
  const score =
    summary?.sectionDetails
      ?.flatMap((d) => Object.values(d.values || {}))
      ?.find((v) => v?.title === "Score Serasa")
      ?.value || "N/D";

  const risco = report?.status?.value === "REJECTED" ? "Altíssimo" : "Não crítico"; // mantém padrão do seu script
  // (Padrão do texto: “Risco: Altíssimo”)

  // ===== FUNDAÇÃO / TEMPO (anos e meses, sem “241 meses”) =====
  const dataFundacaoStr =
    basic?.sectionDetails?.find((d) => d?.values?.response)?.values?.response?.dataFundacao;
  const dataFundacao = dataFundacaoStr
    ? new Date(
        dataFundacaoStr.split(" ")[0].split("/").reverse().join("-")
      )
    : null;

  let mesesAbertura = "N/D";
  let tempoAberturaTexto = "N/D";
  if (dataFundacao) {
    mesesAbertura = Math.floor((Date.now() - dataFundacao.getTime()) / (1000 * 60 * 60 * 24 * 30));
    const anos = Math.floor(mesesAbertura / 12);
    const meses = mesesAbertura % 12;
    if (anos === 0) tempoAberturaTexto = `${meses} meses`;
    else if (meses === 0) tempoAberturaTexto = `${anos} anos`;
    else tempoAberturaTexto = `${anos} anos e ${meses} meses`;
  }
  // (Meses→anos/meses exatamente como seu script)

  // ===== PEFIN (valor, (qtd), resolução) =====
  const pefin =
    summary?.sectionDetails
      ?.flatMap((d) => Object.values(d.values || {}))
      ?.find((v) => v?.title === "Pefin");
  const pefinValor = pefin?.value || "R$ 0,00";
  const pefinQtd = pefin?.subValue || "(0)";
  const pefinRecente = pefin?.resolution || "";
  // Linha final segue: “Pefin {valor} {qtd} {resolução}”

  // ===== ALTERAÇÃO DE REGIME =====
  const taxRegimes =
    basic?.sectionDetails?.flatMap(
      (d) => d?.values?.historyData?.company?.historyTaxRegimes || []
    );
  let alteracaoRegimeTexto = "Não identificadas";
  if (taxRegimes && taxRegimes.length >= 2) {
    const anterior = taxRegimes[taxRegimes.length - 2];
    const atual = taxRegimes[taxRegimes.length - 1];
    alteracaoRegimeTexto =
      `${anterior?.taxRegime} > ${atual?.taxRegime} ` +
      `Alteração no regime tributário ${formatarData(atual?.changeDate)}`;
  }
  // (Formato exatamente como no script)

  // ===== SÓCIO =====
  const socio =
    relations?.sectionDetails?.flatMap((d) => d?.values?.relationships || [])?.find((r) =>
      String(r?.relationshipLevel || "").includes("Sócio")
    );
  const socioNome = socio?.name || "N/D";
  const socioCpf = socio?.document || "N/D";
  const socioDesde = socio?.formattedStartDate || "N/D";

  // ===== MOTIVOS “À VISTA” -> conjunto (seus calculados + motor DENIED) =====
  const motivosSet = new Set();
  // calculados por você
  const pefinNumerico = parseFloat(pefinValor.replace(/[^\d,]/g, "").replace(",", "."));
  if (!Number.isNaN(pefinNumerico) && pefinNumerico > 0) {
    motivosSet.add("Valor total em pefin nos últimos 3 anos maior que 0");
  }
  if (!Number.isNaN(Number(score)) && Number(score) < 400) {
    motivosSet.add("Score Bureau menor que 400");
  }
  if (mesesAbertura !== "N/D" && mesesAbertura < 11) {
    motivosSet.add("Tempo de abertura da empresa em meses menor que 11");
  }
  // (Mesmas três regras do seu script)

  // do motor (policyRuleResults DENIED)
  const coletarMotivosDoMotor = (rep) => {
    const out = [];
    const groups =
      rep?.policyRuleGroupResults ||
      rep?.values?.policyRuleGroupResults ||
      rep?.businessDecisions?.policyRuleGroupResults ||
      [];
    const groupsFallback = groups.length ? groups : findAll(rep, "policyRuleGroupResults").flat();
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
            if (desc) out.push(normalizarMotivo(desc));
          }
        }
      }
    }
    // remove duplicados preservando ordem
    return [...new Set(out)];
  };
  coletarMotivosDoMotor(report).forEach((m) => motivosSet.add(m));
  const motivos = Array.from(motivosSet);

  // ===== TEXTO FINAL (idêntico ao padrão do seu script) =====
  // Cabeçalho / blocos / quebras de linha na mesma ordem e rotulagem.
  const texto = `
Cadastro Rápido cliente a vista 

Score: ${score}
Risco: ${risco}

Fundação: ${formatarData(dataFundacao)} - ${tempoAberturaTexto}
Possui restrição: 
Pefin ${pefinValor} ${pefinQtd} ${pefinRecente}

Alterações:
${alteracaoRegimeTexto}

Sócio:
Nome: ${socioNome}
Cpf: ${socioCpf}
Sócio desde: ${socioDesde}

Por que ficou à vista?
${motivos.map((m) => `- ${m}`).join("\n")}
`.trim();

  return texto;
}

export function buildClipboardFromReport(report, opts = {}) {
  const { companyName } = extractReportData(report);
  return buildQualificacaoClipboardText({ ...opts, companyName });
}
