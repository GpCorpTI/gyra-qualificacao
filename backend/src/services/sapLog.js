import { execRows } from '../utils/execRows.js';
import { normalizeCNPJNumeric, formatCNPJMask } from '../utils/cnpj.js';

export async function logSapCreditUpdate({ reportId, cnpj, cardCode, dateSet }) {
  const normalized = normalizeCNPJNumeric(cnpj || '');
  const formatted  = formatCNPJMask(normalized) || cnpj;

  const sql = `
    INSERT INTO sap_credit_updates
      (report_id, cnpj, normalized_cnpj, formatted_cnpj, cardcode, date_set)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE created_at = created_at
  `;
  await execRows(sql, [String(reportId||''), String(cnpj||''), normalized, formatted, String(cardCode||''), dateSet]);
}
