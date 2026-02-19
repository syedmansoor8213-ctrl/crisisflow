const crypto = require('crypto');
const { supabase } = require('./_utils');

const attempts = {};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Rate limit: max 10 attempts per IP per 15 minutes
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  attempts[ip] = (attempts[ip] || []).filter(t => now - t < 900000);
  if (attempts[ip].length >= 10) {
    return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  }
  attempts[ip].push(now);

  const { email, secret_key } = req.body;
  if (!email || !secret_key) return res.status(400).json({ error: 'Missing fields' });

  const hash = crypto.createHash('sha256').update(secret_key).digest('hex');

  const { data: owner } = await supabase
    .from('owners')
    .select('id, email, business_name, owner_name, tenant_id, status, secret_key_hash, service_area, radius_miles, job_types, min_job_value, timezone, phone')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!owner || hash !== owner.secret_key_hash) {
    return res.status(200).json({ success: false });
  }

  if (owner.status === 'frozen') {
    return res.status(200).json({ success: true, frozen: true });
  }

  // Never send secret_key_hash to browser
  const { secret_key_hash: _, ...safeOwner } = owner;
  return res.status(200).json({ success: true, owner: safeOwner });
};
