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
  const mainStatus = report?.status?.value || 'Sem status';
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

  const companyName = extractCompanyName(report);
  return { companyName, mainStatus, riskInfo: Array.from(risks), policySummaries };
}
