import { pool } from '../../db.js';
export async function execRows(sql, params=[]){
  const res = await pool.execute(sql, params);
  if (Array.isArray(res)) return res[0];
  if (res && Array.isArray(res.rows)) return res.rows;
  return res;
}
