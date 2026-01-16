import express from 'express';
import axios from 'axios';

const router = express.Router();

// POST /api/token  -> fetch Gyra+ access token
router.post('/token', async (req, res) => {
  try {
    const response = await axios.post(
      'https://gyra-core.gyramais.com.br/auth/authenticate',
      {},
      {
        headers: {
          'gyra-client-id': process.env.GYRA_CLIENT_ID,
          'gyra-client-secret': process.env.GYRA_CLIENT_SECRET,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const userId = response.data?.userId;
    req.log?.info?.({ userId }, '✅ Gyra+ token issued'); // safe logging
    return res.json({ token: response.data.accessToken });
  } catch (err) {
    const gyraMsg = err.response?.data;
    req.log?.error?.({ err: err.message, gyraMsg }, '❌ /api/token failed');
    console.error('❌ /api/token:', gyraMsg || err.message);
    return res.status(500).json({ error: 'Token request failed' });
  }
});

export default router;
