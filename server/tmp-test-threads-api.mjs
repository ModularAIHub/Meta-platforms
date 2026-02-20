import dotenv from 'dotenv';
import pkg from 'pg';
import axios from 'axios';

dotenv.config({ path: './.env' });
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.DB_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

const res = await pool.query("select account_id, access_token from social_connected_accounts where platform='threads' and is_active=true order by updated_at desc limit 1");
await pool.end();
if (!res.rows[0]) {
  console.log('No threads account found');
  process.exit(0);
}

const accountId = String(res.rows[0].account_id);
const token = String(res.rows[0].access_token);

try {
  const me = await axios.get('https://graph.threads.net/v1.0/me', {
    params: { fields: 'id,username', access_token: token },
    timeout: 15000,
  });
  console.log('ME_OK', me.data);
} catch (e) {
  console.log('ME_FAIL', e.response?.status, e.response?.data || e.message);
}

try {
  const payload = new URLSearchParams();
  payload.append('media_type', 'TEXT');
  payload.append('text', 'SuiteGenie test post');
  payload.append('access_token', token);

  const create = await axios.post(`https://graph.threads.net/v1.0/${accountId}/threads`, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });

  console.log('CREATE_OK', create.data);
} catch (e) {
  console.log('CREATE_FAIL', e.response?.status, e.response?.data || e.message);
}
