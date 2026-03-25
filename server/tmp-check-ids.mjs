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

const accountId = String(res.rows[0].account_id);
const token = String(res.rows[0].access_token);
console.log('DB Account ID:', accountId);

try {
    const me = await axios.get('https://graph.threads.net/v1.0/me', {
        params: { fields: 'id,username', access_token: token },
        timeout: 15000,
    });
    console.log('Live ME ID:', me.data.id);
} catch (e) {
    console.log('Error', e.message);
}
