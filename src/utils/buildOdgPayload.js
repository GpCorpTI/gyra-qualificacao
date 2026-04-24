// src/utils/buildOdgPayload.js
//
// Mapeia o fullReport da API Gyra+ para os campos do template ODG.
// Usa cleanDescription já existente em reportUtils.js.
//
// Campos esperados pelo template:
//   Nome_Negocio, CNPJ_Negocio, Data_Consulta, Resultado_Analise,
//   Resumo_Empresa, Pontos_Serasa, Restricoes_Negocio, Reprovacao_Negocio,
//   Socio_Negocio, Cadastro_Negocio, Certidao_Negocio, Falencias_Negocio

import { cleanDescription } from './reportUtils';

// ── helpers internos ──────────────────────────────────────────────────────────

/** Formata data ISO ou "dd/mm/aaaa hh:mm:ss" → dd/mm/aaaa */
function fmtDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  return isNaN(d) ? String(raw).split(' ')[0] : d.toLocaleDateString('pt-BR');
}

/**
 * Varre todas as sections/sectionDetails e retorna o primeiro
 * objeto `values[key]` encontrado.
 */
function findValues(sections, key) {
  for (const sec of sections) {
    for (const det of sec.sectionDetails || []) {
      if (det.values && key in det.values) return det.values[key];
    }
  }
  return null;
}

/**
 * Retorna o objeto values.response da section que tiver razaoSocial/socios.
 * No JSON real fica em BASIC_INFORMATION > sectionDetails[n].values.response
 */
function getResponse(sections) {
  return findValues(sections, 'response') || {};
}

// ── extratores por campo ──────────────────────────────────────────────────────

function getNomeNegocio(sections) {
  // legalName é um campo direto em values (linha ~1103 do JSON real)
  const legalName = findValues(sections, 'legalName');
  if (legalName) return legalName;

  // Fallback: response.razaoSocial
  const resp = getResponse(sections);
  return resp.razaoSocial || resp.nomeFantasia || '—';
}

function getCnpj(report) {
  // response.cnpj já vem formatado: "57.151.198/0001-21"
  const resp = getResponse(report.sections || []);
  if (resp.cnpj) return resp.cnpj;

  const d = (report.document || '').replace(/\D/g, '');
  if (d.length === 14)
    return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
  return report.document || '—';
}

function getDataConsulta(report) {
  return fmtDate(report.createdAt);
}

function getResultadoAnalise(report) {
  const map = {
    APPROVED: 'Aprovado',
    REJECTED: 'Reprovado',
    PENDING:  'Pendente',
    MANUAL:   'Análise manual',
    DENIED:   'Negado',
  };
  // status.value pode ser "REJECTED", status.key também
  const key = (report.status?.value || report.status?.key || '').toUpperCase();
  return map[key] || report.status?.value || '—';
}

function getResumoEmpresa(sections) {
  // Todos os campos ficam em values.response (BASIC_INFORMATION)
  const resp = getResponse(sections);
  if (!resp.razaoSocial) return '—';

  const partes = [];
  if (resp.razaoSocial)               partes.push(`Razão social: ${resp.razaoSocial}`);
  if (resp.nomeFantasia)              partes.push(`Nome fantasia: ${resp.nomeFantasia}`);
  if (resp.situacaoCadastral)         partes.push(`Situação: ${resp.situacaoCadastral}`);
  if (resp.dataFundacao)              partes.push(`Fundação: ${resp.dataFundacao.split(' ')[0]}`);
  if (resp.cnaeDescricao)             partes.push(`Atividade: ${resp.cnaeDescricao}`);
  if (resp.porte)                     partes.push(`Porte: ${resp.porte}`);
  if (resp.faixaFaturamento)          partes.push(`Faturamento estimado: ${resp.faixaFaturamento}`);
  if (resp.naturezaJuridicaDescricao) partes.push(`Natureza jurídica: ${resp.naturezaJuridicaDescricao}`);

  const end = resp.enderecos?.[0];
  if (end) {
    const addr = [end.logradouro, end.numero, end.bairro, end.cidade, end.uf]
      .filter(Boolean).join(', ');
    if (addr) partes.push(`Endereço: ${addr}`);
  }
  return partes.join('\n');
}

function getPontosSerasa(sections) {
  // serasaScoreSummary.value → "2" (no JSON de exemplo)
  const s = findValues(sections, 'serasaScoreSummary');
  return s?.value !== undefined ? String(s.value) : '—';
}

function getRestricoesNegocio(sections) {
  const itens = [];

  const pefin = findValues(sections, 'pefinsSummary');
  if (pefin?.value && pefin.value !== 'R$ 0,00')
    itens.push(`Pefin: ${pefin.value} ${pefin.subValue || ''}${pefin.resolution ? ' — ' + pefin.resolution : ''}`);

  const refin = findValues(sections, 'refinsSummary');
  if (refin?.value && refin.value !== 'R$ 0,00')
    itens.push(`Refin: ${refin.value} ${refin.subValue || ''}${refin.resolution ? ' — ' + refin.resolution : ''}`);

  const protestos = findValues(sections, 'protestsBaseSummary');
  if (protestos?.value && protestos.value !== 'R$ 0,00')
    itens.push(`Protestos: ${protestos.value} ${protestos.subValue || ''}${protestos.resolution ? ' — ' + protestos.resolution : ''}`);

  const cheques = findValues(sections, 'checksSummary');
  if (cheques?.value && cheques.value !== 0 && cheques.value !== '0')
    itens.push(`Cheque sem fundo: ${cheques.value}`);

  return itens.length ? itens.join('\n') : 'Nenhuma restrição encontrada.';
}

function getReprovacaoNegocio(sections) {
  const motivos = new Set();
  for (const sec of sections) {
    for (const det of sec.sectionDetails || []) {
      for (const group of det.values?.policyRuleGroupResults || []) {
        for (const join of group.policyRuleResultJoins || []) {
          if (['REJECTED', 'DENIED'].includes(join.status?.key)) {
            for (const rule of join.policyRuleResults || []) {
              const desc = cleanDescription(rule.descriptions || '');
              if (desc) motivos.add(desc);
            }
          }
        }
      }
    }
  }
  return motivos.size ? [...motivos].join('\n') : '—';
}

function getSocioNegocio(sections) {
  // socios ficam em values.response.socios (BASIC_INFORMATION)
  const resp = getResponse(sections);
  const socios = resp.socios || [];
  if (!socios.length) return '—';

  return socios.map(s => {
    const nome  = s.nome  || s.name || '?';
    const cargo = s.cargo  ? ` (${s.cargo})` : '';
    const doc   = s.documento || s.document || '';
    const desde = s.dataEntrada ? ` — desde ${s.dataEntrada.split(' ')[0]}` : '';
    return `${nome}${cargo}${doc ? ' — ' + doc : ''}${desde}`;
  }).join('\n');
}

function getCadastroNegocio(sections) {
  // response.situacaoCadastral → "ATIVA"
  const resp = getResponse(sections);
  return resp.situacaoCadastral || '—';
}

function getCertidaoNegocio(sections) {
  // Cada certidão individual tem { valid: bool, error: bool }
  // + totalCertificates no mesmo sectionDetail
  let valid = 0, invalid = 0, total = 0;

  const certKeys = [
    'fgtsCertificate', 'pgfnCertificate', 'boardCertificate',
    'debtLaborAbsenceCertificate', 'debtAbsenceStateCertificate',
  ];

  for (const sec of sections) {
    for (const det of sec.sectionDetails || []) {
      const v = det.values || {};
      if (v.totalCertificates) total = Math.max(total, Number(v.totalCertificates));
      for (const key of certKeys) {
        if (v[key]) { v[key].valid ? valid++ : invalid++; }
      }
    }
  }

  if (!total && !valid) return '—';
  return `${valid} válida(s) / ${invalid} inválida(s) de ${total || valid + invalid} certidão(ões).`;
}

function getFalenciasNegocio(sections) {
  // SERASA.bankrupt → { occurrenceDate, eventType }
  const serasa = findValues(sections, 'SERASA');
  if (serasa?.bankrupt) {
    const b = serasa.bankrupt;
    if (!b.occurrenceDate || b.occurrenceDate === '-') return 'Sem ocorrências.';
    return `${b.eventType || 'Ocorrência'} em ${b.occurrenceDate}`;
  }
  return 'Sem ocorrências.';
}

// ── exportação principal ──────────────────────────────────────────────────────

/**
 * @param {Object} report  fullReport retornado pela API Gyra+
 * @returns {Object}       Objeto com todos os campos do template ODG
 */
export function buildOdgPayload(report) {
  const sections = report.sections || [];
  return {
    Nome_Negocio:       getNomeNegocio(sections),
    CNPJ_Negocio:       getCnpj(report),
    Data_Consulta:      getDataConsulta(report),
    Resultado_Analise:  getResultadoAnalise(report),
    Resumo_Empresa:     getResumoEmpresa(sections),
    Pontos_Serasa:      getPontosSerasa(sections),
    Restricoes_Negocio: getRestricoesNegocio(sections),
    Reprovacao_Negocio: getReprovacaoNegocio(sections),
    Socio_Negocio:      getSocioNegocio(sections),
    Cadastro_Negocio:   getCadastroNegocio(sections),
    Certidao_Negocio:   getCertidaoNegocio(sections),
    Falencias_Negocio:  getFalenciasNegocio(sections),
  };
}
