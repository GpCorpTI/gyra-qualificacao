import './config/env.js';                
import express from 'express';
import cors from 'cors';
import { mountSPA } from './static/spa.js';
import { logging } from './middleware/logging.js';
import reportRoutes from './routes/report.js';
import authRoutes from './routes/auth.js';
import notifyTestRoutes from './routes/notify-test.js';

const app = express();
app.use(express.json());
app.use(cors());
app.use(logging);

app.get('/health', (_req,res)=>res.json({ ok:true }));

app.use('/api', authRoutes);
app.use('/api', reportRoutes);
app.use('/api', notifyTestRoutes);
mountSPA(app);

export default app;
