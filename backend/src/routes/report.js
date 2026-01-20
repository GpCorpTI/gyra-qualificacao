import express from 'express';
import axios from 'axios';
import XLSX from 'xlsx';
import { execRows } from '../utils/execRows.js';
import { normalizeCNPJNumeric, isValidCNPJ, formatCNPJMask } from '../utils/cnpj.js';
import { getCardCodeByCNPJ_HANA } from '../services/hana.js';
import { sapCreateSession, sapUpdateUltimaAnaliseCredito } from '../services/sap.js';
import { logSapCreditUpdate } from '../services/sapLog.js';
import { notifyApprovedUpdate } from '../services/notifyTeams.js';

const router = express.Router();

function cleanDescription(text){ return (text||'').replace(/\{\{.*?\}\}/g,'').trim(); }
function extractCompanyName(r){ const s=r?.sections||[]; for(const sec of s){ for(const det of (sec.sectionDetails||[])){ const v=det?.values||{}; if (typeof v.name==='string' && v.name.trim()) return v.name.trim(); } } return ''; }
function extractReportSummary(report){
  const statusValue = report?.status?.value || null;
  const sections = report?.sections || [];
  const risksSet = new Set(); const rulesArr = [];
  sections.forEach(section=>{
    (section.sectionDetails||[]).forEach(detail=>{
      const values = detail.values||{};
      if (values.risk) risksSet.add(values.risk);
      (values.policyRuleGroupResults||[]).forEach(group=>{
        (group.policyRuleResultJoins||[]).forEach(join=>{
          (join.policyRuleResults||[]).forEach(rule=>{
            const key=rule?.status?.key;
            if (key==='DENIED'||key==='ALERT'){
              rulesArr.push({ description: cleanDescription(rule.descriptions), status: rule.status?.value||'' });
            }
          });
        });
      });
    });
  });
  return { statusValue, risks:[...risksSet], rules:rulesArr, businessName: extractCompanyName(report) };
}

// POST /api/report  (create or reuse <=90d)
router.post('/report', async (req,res)=>{
  const start = Date.now(); let reused=false;
  try{
    const { token, cnpj, policyId, sector } = req.body;
    const normalized = normalizeCNPJNumeric(cnpj);
    if (!isValidCNPJ(normalized)) return res.status(400).json({ error:'CNPJ inválido' });
    const formatted = formatCNPJMask(normalized);

    const exists = await execRows(`
      SELECT id, report_id, formatted_cnpj, created_at
      FROM cnpj_reports
      WHERE normalized_cnpj = ?
        AND created_at > NOW() - INTERVAL 90 DAY
      ORDER BY created_at DESC
      LIMIT 1`, [normalized]);

    if (exists.length){
      reused = true;
      return res.json({ id: exists[0].report_id, reused, cnpj: normalized, formatted: exists[0].formatted_cnpj||formatted });
    }

    const created = await axios.post('https://gyra-core.gyramais.com.br/report', { document: normalized, policyId }, { headers:{ Authorization:`Bearer ${token}` }});
    const reportId = created.data?.id || created.data?.reportId;

    await execRows(
      `INSERT INTO cnpj_reports (cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`, [cnpj, normalized, formatted, reportId, sector || null]
    );
    const dur = Date.now()-start;
    req.log.info({ cnpj, sector, reportId, reused, ms: dur }, 'report.create');
    res.json({ id: reportId, reused:false, cnpj: normalized, formatted });
  }catch(err){
    const dur=Date.now()-start;
    req.log.error({ err: err.message, ms: dur }, 'report.create.fail');
    res.status(500).json({ error: err.message });
  }
});

// GET /api/report/:id (fetch + update SAP if Approved)
router.get('/report/:id', async (req,res)=>{
  const reportId = req.params.id; const start = Date.now();
  let createdAt=null; let needsUpdate=false;
  try{
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error:'Missing Authorization Bearer token' });

    const cRow = await execRows('SELECT created_at FROM cnpj_reports WHERE report_id = ? LIMIT 1',[reportId]);
    createdAt = cRow?.[0]?.created_at || null;

    const full = await axios.get(`https://gyra-core.gyramais.com.br/report/${reportId}`, { headers:{ Authorization:`Bearer ${token}` }});
    const fullReport = full.data;

    const cur = await execRows('SELECT status_value FROM cnpj_reports WHERE report_id = ? LIMIT 1',[reportId]);
    const current = cur?.[0]?.status_value;
    needsUpdate = current == null || String(current).trim()==='' || String(current).toUpperCase()==='PENDING';

    if (needsUpdate){
      const { statusValue, risks, rules, businessName } = extractReportSummary(fullReport);
      await execRows(
        `UPDATE cnpj_reports SET status_value=?, risks=?, rules=?, business_name=? WHERE report_id=?`,
        [statusValue||null, JSON.stringify(risks||[]), JSON.stringify(rules||[]), businessName||null, reportId]
      );
    }

    const statusFromReport = fullReport?.status?.value || extractReportSummary(fullReport).statusValue;
    const updateSap = String(statusFromReport||'').toUpperCase()==='APPROVED';

    if (updateSap){
      try{
        const rows = await execRows('SELECT cnpj FROM cnpj_reports WHERE report_id = ? LIMIT 1',[reportId]);
        const cnpjForLookup = rows?.[0]?.cnpj;

        if (!cnpjForLookup){
          res.set('X-SAP-Update','skipped'); res.set('X-SAP-Reason','NO_CNPJ_IN_DB');
        } else {
          const cardCode = await getCardCodeByCNPJ_HANA(cnpjForLookup);
          if (!cardCode){
            res.set('X-SAP-Update','skipped'); res.set('X-SAP-Reason','BP_NOT_FOUND_FOR_CNPJ');
          } else {
            const sap = await sapCreateSession();
            const today = new Date().toISOString().slice(0,10);
            await sapUpdateUltimaAnaliseCredito(sap, cardCode, today);   
            // Table update:
            await logSapCreditUpdate({
            reportId,
            cnpj: cnpjForLookup,
            cardCode,
            dateSet: today
            });
            //  Teams notification
            await notifyApprovedUpdate({ reportId, cnpj: cnpjForLookup, cardCode, dateSet: today });

            res.set('X-SAP-Update','success'); res.set('X-SAP-CardCode', cardCode);
          }
        }
      }catch(e){
        res.set('X-SAP-Update','skipped'); res.set('X-SAP-Reason','SAP_UPDATE_ERROR');
      }
    } else {
      res.set('X-SAP-Update','skipped'); res.set('X-SAP-Reason','NOT_APPROVED');
    }

    const dur = Date.now()-start;
    req.log.info({ reportId, createdAt, updated: needsUpdate, ms: dur }, 'report.fetch');
    res.json({ ...fullReport, createdAt });
  }catch(err){
    const dur=Date.now()-start;
    req.log.error({ err: err.message, reportId, createdAt, updated: needsUpdate, ms: dur }, 'report.fetch.fail');
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// GET /api/reports  (last 90d)
router.get('/reports', async (_req,res)=>{
  try{
    const rows = await execRows(`
      SELECT id, cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, business_name,
             status_value, risks, rules, created_at
      FROM cnpj_reports
      WHERE created_at > NOW() - INTERVAL 90 DAY
      ORDER BY created_at DESC`);
    res.json(rows);
  }catch(err){ res.status(500).json({ error: err.message }); }
});

// GET /api/reports.xlsx
router.get('/reports.xlsx', async (_req,res)=>{
  try{
    const rows = await execRows(`
      SELECT id, cnpj, normalized_cnpj, formatted_cnpj, report_id, sector, business_name, status_value, created_at
      FROM cnpj_reports
      WHERE created_at > NOW() - INTERVAL 90 DAY
      ORDER BY created_at DESC`);
    const data = rows.map(r=>({
      ID: r.id, CNPJ_ORIGINAL:r.cnpj, CNPJ_NORMALIZADO:r.normalized_cnpj, CNPJ_FORMATADO:r.formatted_cnpj,
      REPORT_ID:r.report_id, SETOR:r.sector, NOME_EMPRESA:r.business_name, STATUS_GERAL:r.status_value, CRIADO_EM:r.created_at
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'reports_90d');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="reports_90d.xlsx"');
    res.send(buf);
  }catch(err){ res.status(500).json({ error: err.message }); }
});

export default router;
