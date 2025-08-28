import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { pool } from './db.js';   // ✅ usa o pool centralizado

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

function extractReportSummary(report) {
  const statusValue = report?.status?.value || null;

  const riskSet = new Set();
  const rules = [];
  let businessName = null;

  const sections = report?.sections || [];
  sections.forEach(section => {
    (section.sectionDetails || []).forEach(detail => {
      const values = detail?.values || {};

      if (values.risk) {
        riskSet.add(values.risk);
      }

      (values.policyRuleGroupResults || []).forEach(group => {
        (group.policyRuleResultJoins || []).forEach(join => {
          (join.policyRuleResults || []).forEach(rule => {
            const key = rule?.status?.key;
            if (key === 'ALERT' || key === 'DENIED') {
              const rawDesc = rule?.descriptions || '';
              const cleanDescription = rawDesc.replace(/\{\{.*?\}\}/g, '').trim();
              rules.push({
                description: cleanDescription,
                status: rule?.status?.value || ''});
            }
          });
        });
      });
      if (!businessName) {
        const candidate =
          values.name;
        if (candidate) businessName = String(candidate).trim();
      }
    });
  });

  return {
    statusValue,
    risks: Array.from(riskSet),
    rules,
    businessName
  };
}
// 🔐 Token
app.post('/api/token', async (req, res) => {
  try {
    const response = await axios.post(
      'https://gyra-core.gyramais.com.br/auth/authenticate',
      {},
      {
        headers: {
          'gyra-client-id': process.env.GYRA_CLIENT_ID,
          'gyra-client-secret': process.env.GYRA_CLIENT_SECRET,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json({ token: response.data.accessToken });
  } catch (err) {
    console.error('❌ /api/token:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🧾 Gera/recicla report (salva só o id)
app.post('/api/report', async (req, res) => {
  const { token, cnpj, policyId, sector } = req.body;

  try {
    // verifica reaproveitamento nos últimos 90 dias
    const [rows] = await pool.execute(
      `SELECT report_id, created_at 
        FROM cnpj_reports 
        WHERE cnpj = ? 
        AND created_at > NOW() - INTERVAL 90 DAY
        ORDER BY created_at DESC
        LIMIT 1`,
      [cnpj]
    );

    if (rows.length > 0) {
      return res.json({ reused: true, reportId: rows[0].report_id });
    }

    // gera novo relatório na Gyra+
    const response = await axios.post(
      'https://gyra-core.gyramais.com.br/report',
      { document: cnpj, policyId },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const reportId = response.data.id;

    // insere/atualiza (garanta UNIQUE(cnpj) na tabela)
    await pool.execute(
      `INSERT INTO cnpj_reports (cnpj, report_id, sector, created_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE report_id = VALUES(report_id), created_at = NOW()`,
      [cnpj, reportId, sector ?? null]
    );

    res.json({ reused: false, reportId });
  } catch (err) {
    console.error('❌ /api/report:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🔎 Busca um report na Gyra+ pelo id salvo
app.get('/api/report/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const reportId = req.params.id;

    // 1) Checar se já está preenchido (evita UPDATE desnecessário)
    const [rows] = await pool.execute(
      'SELECT status_value FROM cnpj_reports WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    const currentStatus = rows.length ? (rows[0].status_value || '').trim() : '';
    const currentName   = rows.length ? (rows[0].business_name || '').trim() : '';
    
    const isEmpty = currentStatus === '';
    const isPending = currentStatus.toUpperCase() === 'PENDING';
    const updateNeeded = isEmpty || isPending;

    // 2) Sempre busca relatório completo na Gyra+ (precisamos retornar ao front)
    const response = await axios.get(
      `https://gyra-core.gyramais.com.br/report/${reportId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const fullReport = response.data;

    const { statusValue, risks, rules, businessName } = extractReportSummary(fullReport);

    // Atualiza resumo UMA vez (quando vazio/pendente)
    if (updateNeeded) {
      const rulesToStore = (rules || []).map(r => ({ description: r.description, status: r.status }));
      await pool.execute(
        `UPDATE cnpj_reports
            SET status_value = ?,
                risks = ?,
                rules = ?
          WHERE report_id = ?
            AND (
                  status_value IS NULL
               OR status_value = ''
               OR UPPER(status_value) = 'PENDING'
               OR UPPER(status_value) = 'PENDENTE'
            )`,
        [
          statusValue || null,
          JSON.stringify(risks || []),
          JSON.stringify(rulesToStore),
          reportId
        ]
      );
    }

    // Garante salvar o NOME se ainda não estiver salvo (independente do status)
    if (!currentName && businessName) {
      await pool.execute(
        `UPDATE cnpj_reports
            SET business_name = ?
          WHERE report_id = ?
            AND (business_name IS NULL OR business_name = '')`,
        [businessName, reportId]
      );
    }

    // 4) Retorna o relatório completo
    res.json(fullReport);
  } catch (err) {
    console.error('❌ /api/report/:id:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});


// 📃 Lista ids salvos
app.get('/api/reports', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, cnpj, business_name, report_id, sector, created_at FROM cnpj_reports WHERE created_at > NOW() - INTERVAL 90 DAY ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/reports:', err.message);
    res.status(500).json({ error: err.message });
  }
});

import * as XLSX from 'xlsx'
app.get('/api/reports.xlsx', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, cnpj, business_name, report_id, sector, status_value, risks, rules, created_at FROM cnpj_reports WHERE created_at > NOW() - INTERVAL 90 DAY ORDER BY created_at DESC')

    const data = rows.map(r => ({
      CNPJ: r.cnpj,
      Nome: r.business_name,
      ReportID: r.report_id,
      Setor: r.sector || '',
      Status: r.status_value,
      Riscos: r.risks,
      Regras: r.rules,
      CriadoEm: new Date(r.created_at).toISOString()
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Relatorios')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="relatorios.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error(e)
    res.status(500).send('Erro ao exportar XLSX')
  }
})

// 💡 encerra pool
const shutdown = async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(3001, () => {
  console.log('✅ Backend API ready at http://localhost:3001');
});
