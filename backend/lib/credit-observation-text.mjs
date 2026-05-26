function normalizeTitle(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function findSummaryItemsByTitles(report, titles = []) {
  const wantedTitles = titles.map(normalizeTitle);
  const summary = (report?.sections || []).find((section) => section?.type?.value === 'SUMMARY');
  const matches = [];

  for (const detail of summary?.sectionDetails || []) {
    for (const value of Object.values(detail?.values || {})) {
      if (value && typeof value === 'object' && wantedTitles.includes(normalizeTitle(value.title))) {
        matches.push(value);
      }
    }
  }

  return matches;
}

function findSummaryItemByTitles(report, titles = []) {
  return findSummaryItemsByTitles(report, titles)[0] || null;
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

function findNestedValuesByKeys(obj, keys = [], out = []) {
  if (!obj || typeof obj !== 'object') return out;

  for (const [key, value] of Object.entries(obj)) {
    if (keys.includes(key) && value != null && String(value).trim() !== '') {
      out.push(value);
    }
    findNestedValuesByKeys(value, keys, out);
  }

  return out;
}

function formatShortDate(value) {
  if (!value) return '';

  if (typeof value === 'string' && /^\d{2}\/\d{4}/.test(value)) return value;
  if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}/.test(value)) return value.slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [year, month, day] = value.slice(0, 10).split('-');
    return `${day}/${month}/${year}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);

  return parsed.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
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
    .filter((partner) =>
      String(partner?.relationshipLevel || partner?.relationshipType || '').toLowerCase().includes('sócio') ||
      String(partner?.relationshipLevel || partner?.relationshipType || '').toLowerCase().includes('socio') ||
      String(partner?.relationshipType || '').toUpperCase() === 'QSA'
    )
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

function extractRestrictionsSummary(report) {
  const items = [
    ['Pefin', findSummaryItemByTitles(report, ['Pefin'])],
    ['Refin', findSummaryItemByTitles(report, ['Refin'])],
    ['Protestos', findSummaryItemByTitles(report, ['Protestos'])],
  ];

  const restrictions = items
    .filter(([, item]) => parseCurrencyNumber(item?.value) > 0 || parseCurrencyNumber(item?.subValue) > 0)
    .map(([label, item]) => [
      `${label}:`,
      item?.value,
      item?.subValue,
      item?.resolution,
    ].filter(Boolean).join(' '));

  return restrictions.length ? restrictions.join(' | ') : 'Não identificadas';
}

function extractEstimatedBilling(report) {
  return findSummaryItemByTitles(report, [
    'Faturamento estimado',
    'Faturamento presumido',
  ])?.value || '';
}

function extractSocialCapital(report, basicResponse = {}) {
  return (
    basicResponse?.capitalSocial ||
    basicResponse?.shareCapital ||
    findNestedValueByKeys(report, ['capitalSocial', 'shareCapital', 'socialCapital', 'capital']) ||
    'N/D'
  );
}

function cleanDescription(text) {
  return String(text || '').replace(/\{\{.*?\}\}/g, '').trim();
}

function extractProcessPolicyRules(report) {
  const rules = [];
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node.policyRuleResults)) {
      node.policyRuleResults.forEach((rule) => {
        const description = cleanDescription(rule?.descriptions || '');
        if (!description || !normalizeTitle(description).includes('process')) return;

        const status = rule?.status?.value || rule?.status?.key || '';
        const text = status ? `${description} (${status})` : description;
        if (seen.has(text)) return;
        seen.add(text);
        rules.push(text);
      });
    }

    Object.values(node).forEach(walk);
  };

  walk(report);
  return rules;
}

function formatLawsuitDetail(lawsuit) {
  const value = Number(lawsuit?.value || 0);
  const title = lawsuit?.title || lawsuit?.subjects || 'Sem assunto informado';
  const latestMovement = Array.isArray(lawsuit?.history)
    ? lawsuit.history
        .slice()
        .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))[0]
    : null;

  return [
    lawsuit?.number ? `Processo ${lawsuit.number}` : 'Processo sem número',
    lawsuit?.courtType ? `Tipo: ${lawsuit.courtType}` : '',
    lawsuit?.status ? `Status: ${lawsuit.status}` : '',
    lawsuit?.formattedDate || lawsuit?.date ? `Data: ${lawsuit.formattedDate || formatShortDate(lawsuit.date)}` : '',
    value ? `Valor: ${value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : '',
    `Assunto: ${title}`,
    latestMovement?.content ? `Último andamento: ${String(latestMovement.content).slice(0, 180)}` : '',
  ].filter(Boolean).join(' - ');
}

function extractLawsuitsSummary(report) {
  const lawsuitBlocks = findNestedValuesByKeys(report, ['lawsuits'])
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.lawsuits));
  const selectedBlock = lawsuitBlocks
    .slice()
    .sort((a, b) => Number(b?.total || 0) - Number(a?.total || 0))[0];

  if (selectedBlock?.lawsuits?.length) {
    const lawsuits = selectedBlock.lawsuits
      .slice()
      .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))
      .slice(0, 3)
      .map(formatLawsuitDetail);

    const suffix = Number(selectedBlock.total) > lawsuits.length
      ? ` | +${Number(selectedBlock.total) - lawsuits.length} processo(s)`
      : '';
    return `${Number(selectedBlock.total) || lawsuits.length} processo(s): ${lawsuits.join(' | ')}${suffix}`;
  }

  const processRules = extractProcessPolicyRules(report);
  if (processRules.length) return processRules.slice(0, 4).join(' | ');

  const items = findSummaryItemsByTitles(report, ['Processos'])
    .filter((item) => item?.value || item?.subValue || item?.resolution);

  if (!items.length) return 'N/D';

  return items
    .map((item) => [
      'Resumo financeiro de processos',
      item?.value,
      item?.subValue,
      item?.resolution,
      'detalhe do assunto não disponível neste retorno',
    ].filter(Boolean).join(' '))
    .join(' | ');
}

function extractChangesSummary(report) {
  const changesFound = [];
  const historyDataDetails = findNestedValuesByKeys(report, ['historyData'])
    .find((value) => value && typeof value === 'object' && value.company)?.company || {};

  const latestHistoryName = (historyDataDetails.historyNames || [])
    .slice()
    .sort((a, b) => String(b?.changeDate || '').localeCompare(String(a?.changeDate || '')))[0];
  const latestMainActivity = (historyDataDetails.historyActivities || [])
    .filter((activity) => activity?.isMainEconomicActivity)
    .slice()
    .sort((a, b) => String(b?.changeDate || '').localeCompare(String(a?.changeDate || '')))[0];
  const latestSecondaryActivities = (historyDataDetails.historyActivities || [])
    .filter((activity) => !activity?.isMainEconomicActivity)
    .slice(0, 2);

  const changeLabels = [
    [
      'basicDataChanges',
      'Dados cadastrais',
      () => [
        latestHistoryName?.officialName ? `Razão social: ${latestHistoryName.officialName}` : '',
        latestHistoryName?.tradeName ? `Fantasia: ${latestHistoryName.tradeName}` : '',
        latestMainActivity?.code ? `CNAE principal: ${latestMainActivity.code} - ${latestMainActivity.activity || 'N/D'}` : '',
        latestSecondaryActivities.length
          ? `CNAEs secundários: ${latestSecondaryActivities.map((activity) => `${activity.code} - ${activity.activity || 'N/D'}`).join('; ')}`
          : '',
      ].filter(Boolean).join('; '),
    ],
    ['addressesChanges', 'Endereço', () => ''],
    ['economicGroupChanges', 'Grupo econômico', () => ''],
  ];

  for (const [key, label, getDetails] of changeLabels) {
    const changes = findNestedValuesByKeys(report, [key])
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter(Boolean);

    if (changes.length) {
      const latest = changes
        .map((change) => change?.date || change?.changeDate)
        .filter(Boolean)
        .sort()
        .pop();
      const details = getDetails?.();
      changesFound.push({
        label,
        date: latest || '',
        text: `${label}${latest ? ` - última em ${formatShortDate(latest)}` : ''}${details ? ` (${details})` : ''}`,
      });
    }
  }

  const taxRegimes = findNestedValuesByKeys(report, ['historyTaxRegimes'])
    .flatMap((value) => Array.isArray(value) ? value : []);

  if (taxRegimes.length >= 2) {
    const previous = taxRegimes[taxRegimes.length - 2];
    const current = taxRegimes[taxRegimes.length - 1];
    changesFound.push({
      label: 'Regime tributário',
      date: current?.changeDate || '',
      text: `Regime tributário: ${previous?.taxRegime || 'N/D'} > ${current?.taxRegime || 'N/D'}${current?.changeDate ? ` em ${formatShortDate(current.changeDate)}` : ''}`,
    });
  }

  const latestChange = changesFound
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];

  return latestChange?.text || 'N/D';
}

function extractContactsSummary(report) {
  const contacts = [];
  const seen = new Set();
  const addContact = (type, value) => {
    const text = String(value || '').trim();
    if (!text || text === '-') return;
    const key = `${type}:${text}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    contacts.push(`${type}: ${text}`);
  };

  findNestedValuesByKeys(report, ['lemitPrimaryEmail', 'email']).forEach((value) => addContact('Email', value));
  findNestedValuesByKeys(report, ['lemitPrimaryPhoneNumber', 'phone', 'Phone1', 'Phone2', 'Cellular']).forEach((value) => addContact('Telefone', value));

  findNestedValuesByKeys(report, ['lemitSecondaryContacts'])
    .flatMap((value) => Array.isArray(value) ? value : [])
    .forEach((contact) => {
      addContact(contact?.contactType || 'Contato', contact?.contact);
    });

  findNestedValuesByKeys(report, ['emails'])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .forEach((value) => {
      if (typeof value === 'string') addContact('Email', value);
      else addContact('Email', value?.email || value?.contact);
    });

  findNestedValuesByKeys(report, ['phones'])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .forEach((value) => {
      if (typeof value === 'string') addContact('Telefone', value);
      else addContact('Telefone', value?.phone || value?.number || value?.contact);
    });

  return contacts.length ? contacts.join(' | ') : 'N/D';
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
  const socialCapital = extractSocialCapital(report, basicResponse);
  const foundationDate = basicResponse?.dataFundacao || findNestedValueByKeys(report, ['dataFundacao']);
  const registrationStatus =
    basicResponse?.situacaoCadastral ||
    findNestedValueByKeys(report, ['situacaoCadastral']) ||
    'N/D';
  const lawsuits = extractLawsuitsSummary(report);
  const changes = extractChangesSummary(report);
  const contacts = extractContactsSummary(report);
  const restrictionAnswer = hasRestrictionFromSummary(report) ? 'Sim' : 'Não';
  const restrictions = extractRestrictionsSummary(report);
  const partners = extractCurrentPartners(report);
  const partnersText = partners.length
    ? partners.map((partner) => [
        'Qsa:',
        `Nome: ${partner?.name || 'N/D'}`,
        `Cpf: ${partner?.document || 'N/D'}`,
        `Sócio desde: ${partner?.formattedStartDate || partner?.startDate || 'N/D'}`,
        'Score:',
        'Idade:',
        'Restrição:',
        'Vínculo com outros cnpjs:',
      ].join('\n')).join('\n\n')
    : [
        'Qsa:',
        'Nome:',
        'Cpf:',
        'Sócio desde:',
        'Score:',
        'Idade:',
        'Restrição:',
        'Vínculo com outros cnpjs:',
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
Tipo de Sociedade: ${companyType}
Faturamento Anual: ${estimatedBilling}
Capital social: ${socialCapital}
Tem restrição? ${restrictionAnswer}
Restrições: ${restrictions}
 
Processos: ${lawsuits}
Alteração: ${changes}
 
Tempo de CNPJ: ${companyAge}
Situação Cadastral: ${registrationStatus}
 
3. Sócios
${partnersText}
 
Contatos: ${contacts}
`.trim();
}
