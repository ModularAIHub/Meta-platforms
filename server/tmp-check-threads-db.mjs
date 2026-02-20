import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config({ path: './.env' });
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.DB_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

const sql = "select id,user_id,team_id,platform,account_id,account_username,token_expires_at,metadata,updated_at from social_connected_accounts where platform='threads' and is_active=true order by updated_at desc limit 5";

const res = await pool.query(sql);
console.log(JSON.stringify(res.rows, null, 2));
await pool.end();
