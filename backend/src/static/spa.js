import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// read path from env, default to ../dist (frontend at project root)
const distEnv = process.env.FRONTEND_DIST || '../dist';
const distPath = path.resolve(__dirname, distEnv);

export function mountSPA(app) {
  console.log('[SPA] Serving from:', distPath);
  const indexPath = path.join(distPath, 'index.html');

  if (!fs.existsSync(indexPath)) {
    console.error('⚠️ index.html not found at', indexPath);
    // You can throw here if you want to hard-fail:
    // throw new Error(`Frontend build not found at ${indexPath}`);
  }

  app.get('/', (_req, res) => {
    res.redirect('/motorcredito/');
  });

  app.use(
    '/motorcredito',
    express.static(distPath, {
      maxAge: '7d',
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
      },
    })
  );

  app.get('/motorcredito/*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(indexPath);
  });
}
