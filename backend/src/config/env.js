import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

export const PORT = Number(process.env.PORT || 3001);

// DB (mysql pool stays in db.js as you have it)
export const DB = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  name: process.env.DB_NAME,
};

// HANA
export const HANA = {
  server: process.env.HANA_SERVER,
  port: process.env.HANA_PORT,
  uid: process.env.HANA_UID,
  pwd: process.env.HANA_PWD,
  schema: process.env.HANA_SCHEMA,
};

// SAP SL
export const SAP = {
  base: process.env.BASE_SAP,
  companyDb: process.env.COMPANYDB_SAP,
  user: process.env.SAP_USER,
  pass: process.env.SAP_PASSWORD,
};

// Teams Workflow (optional)
export const TEAMS = {
  url: process.env.TEAMS_URL,
  secret: process.env.TEAMS_SECRET,
};
