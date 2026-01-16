import express from 'express';
import { notifyApprovedUpdate } from '../services/notifyTeams.js';

const router = express.Router();

/**
 * POST /api/notify/teams-test
 * Body (optional): { reportId, cnpj, cardCode, dateSet }
 * If omitted, defaults are used so you can test quickly.
 */
router.post('/notify/teams-test', async (req, res) => {
  try {
    const {
      reportId = 'test-report',
      cnpj     = '00.000.000/0000-00',
      cardCode = 'C000000',
      dateSet  = new Date().toISOString().slice(0,10)
    } = req.body || {};

    await notifyApprovedUpdate({ reportId, cnpj, cardCode, dateSet });
    return res.json({
      ok: true,
      sent: { reportId, cnpj, cardCode, dateSet }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
