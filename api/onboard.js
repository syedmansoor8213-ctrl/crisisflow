import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateSecretKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = 'RR-';
  for (let i = 0; i < 12; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const {
    business_name, owner_name, owner_email, owner_phone,
    owner_whatsapp, website, service_types, service_location,
    team_size, gemini_api_key, ads_running, google_business,
    referral_code
  } = req.body;

  // Basic validation
  if (!business_name || !owner_email || !owner_phone || !gemini_api_key || !service_types || !service_location) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check duplicate email
  const { data: existing } = await supabase
    .from('clients')
    .select('tenant_id')
    .eq('owner_email', owner_email)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  // Find salesperson by referral code
  let salesperson_id = null;
  if (referral_code) {
    const { data: sp } = await supabase
      .from('salespeople')
      .select('id')
      .eq('referral_code', referral_code.toUpperCase())
      .single();
    if (sp) salesperson_id = sp.id;
  }

  const secret_key = generateSecretKey();

  const { data, error } = await supabase
    .from('clients')
    .insert({
      business_name, owner_name, owner_email, owner_phone,
      owner_whatsapp, website, service_types, service_location,
      team_size: parseInt(team_size) || 1,
      gemini_api_key, ads_running, google_business,
      referral_code: referral_code || null,
      salesperson_id,
      secret_key,
      status: 'active'
    })
    .select()
    .single();

  if (error) {
    console.error('Onboard error:', error);
    return res.status(500).json({ error: 'Failed to create account' });
  }

  // Send secret key email via Resend (to YOU, not client — you forward manually)
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'system@yourdomain.com',
      to: 'you@youremail.com',
      subject: `New Client Onboarded — ${business_name}`,
      text: `New client registered.\n\nBusiness: ${business_name}\nOwner: ${owner_name}\nEmail: ${owner_email}\nPhone: ${owner_phone}\nTenant ID: ${data.tenant_id}\nSecret Key: ${secret_key}\n\nWebhook URL to paste in RingReady:\nhttps://yourapp.vercel.app/api/webhook-voice?tenant_id=${data.tenant_id}\n\nForward the secret key to the client manually.`
    })
  });

  return res.status(200).json({ success: true, message: 'Onboarding complete. Your secret key will be sent to you shortly.' });
}
