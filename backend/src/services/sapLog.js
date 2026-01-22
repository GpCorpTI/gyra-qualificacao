import { execRows } from '../utils/execRows.js';
import { normalizeCNPJNumeric, formatCNPJMask } from '../utils/cnpj.js';
import { SAP_UPDATE_COOLDOWN_DAYS } from '../config/env.js';

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

export async function findRecentUpdateByCNPJ(cnpj, days = SAP_UPDATE_COOLDOWN_DAYS) {
  const norm = normalizeCNPJNumeric(cnpj || '');
  if (norm.length !== 14) return null;

  const rows = await execRows(`
    SELECT date_set
    FROM sap_credit_updates
    WHERE normalized_cnpj = ?
      AND date_set >= DATE_SUB(CURDATE(), INTERVAL ${Number(days)} DAY)
    ORDER BY date_set DESC
    LIMIT 1
  `, [norm]);

  return rows?.[0]?.date_set || null;
}