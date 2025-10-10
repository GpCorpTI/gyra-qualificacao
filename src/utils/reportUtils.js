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
