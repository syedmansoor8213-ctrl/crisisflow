const crypto = require('crypto');
const { supabase } = require('./_utils');

const adminAttempts = {};

function checkAdmin(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const { password } = req.body;

  adminAttempts[ip] = (adminAttempts[ip] || []).filter(t => now - t < 3600000);
  if (adminAttempts[ip].length >= 5) {
    res.status(429).json({ error: 'Locked for 1 hour' });
    return false;
  }
  adminAttempts[ip].push(now);

  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  if (hash !== process.env.ADMIN_PASSWORD_HASH) {
    res.status(401).json({ error: 'Wrong password' });
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { action, password } = req.body;

  // LOGIN CHECK
  if (action === 'login') {
    if (!checkAdmin(req, res)) return;
    return res.status(200).json({ ok: true });
  }

  if (!checkAdmin(req, res)) return;

  // GET ALL OWNERS
  if (action === 'owners') {
    const { data } = await supabase
      .from('owners')
      .select('id, business_name, owner_name, email, phone, tenant_id, status, referral_name, created_at')
      .order('created_at', { ascending: false });
    return res.status(200).json({ owners: data || [] });
  }

  // GET PENDING ONBOARDING
  if (action === 'pending') {
    const { data } = await supabase
      .from('onboarding_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    return res.status(200).json({ items: data || [] });
  }

  // FREEZE / UNFREEZE
  if (action === 'freeze' || action === 'unfreeze') {
    const { owner_id } = req.body;
    await supabase.from('owners')
      .update({ status: action === 'freeze' ? 'frozen' : 'active' })
      .eq('id', owner_id);
    return res.status(200).json({ ok: true });
  }

  // APPROVE ONBOARDING → ISSUE KEY
  if (action === 'issue_key') {
    const { onboarding_id } = req.body;

    const { data: item } = await supabase
      .from('onboarding_queue')
      .select('*')
      .eq('id', onboarding_id)
      .eq('status', 'pending')
      .single();

    if (!item) return res.status(404).json({ error: 'Not found' });

    const f = item.form_data;

    // Check duplicate
    const { data: existing } = await supabase.from('owners').select('id').eq('email', f.email).single();
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    const tenantId = 'cf_' + crypto.randomBytes(8).toString('hex');
    const secretKey = 'sk_' + crypto.randomBytes(20).toString('hex');
    const secretKeyHash = crypto.createHash('sha256').update(secretKey).digest('hex');

    await supabase.from('owners').insert({
      business_name: f.business_name,
      owner_name: f.owner_name,
      email: f.email.toLowerCase().trim(),
      phone: f.phone,
      tenant_id: tenantId,
      secret_key_hash: secretKeyHash,
      status: 'active',
      service_area: f.service_area,
      radius_miles: f.radius_miles || 25,
      job_types: f.job_types || [],
      min_job_value: f.min_job_value || 200,
      timezone: f.timezone || 'America/New_York',
      vapi_assistant_id: f.vapi_assistant_id || null,
      referral_name: f.referral_name || null
    });

    await supabase.from('onboarding_queue')
      .update({ status: 'approved' })
      .eq('id', onboarding_id);

    // Return key to show in popup — YOU deliver it manually to the client
    return res.status(200).json({ ok: true, tenant_id: tenantId, secret_key: secretKey, email: f.email });
  }

  // SUBMIT ONBOARDING (called from onboard page)
  if (action === 'submit_onboarding') {
    const { form_data, submitted_by } = req.body;
    if (!form_data?.email || !form_data?.business_name) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    await supabase.from('onboarding_queue').insert({
      form_data,
      submitted_by,
      status: 'pending'
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
