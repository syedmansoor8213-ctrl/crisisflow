import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { tenant_id, name, phone, service_type, location, description } = req.body;

  if (!tenant_id || !phone || !description) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const { data: tenant } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenant_id)
    .single();

  if (!tenant || tenant.status === 'frozen') {
    return res.status(404).json({ error: 'Not found' });
  }

  // Classify
  const prompt = `You are a lead qualification engine for a local service business.

Business serves: ${tenant.service_types.join(', ')}
Business location: ${tenant.service_location}
Caller name: ${name}
Service requested: ${service_type}
Their location: ${location}
Their description: ${description}

Classify this lead:
- urgent: active emergency needing immediate response
- qualified: real job, right service, right location, not emergency
- junk: wrong service, wrong location, spam, not real

Respond ONLY with valid JSON:
{"class": "urgent", "reason": "brief reason"}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${tenant.gemini_api_key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 100 }
      })
    }
  );

  const geminiData = await response.json();
  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{"class":"qualified","reason":"fallback"}';
  let classification = { class: 'qualified', reason: 'fallback' };

  try {
    classification = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {}

  const lead = {
    tenant_id,
    source: 'form',
    caller_name: name,
    caller_phone: phone,
    callback_phone: phone,
    job_type: service_type,
    location,
    urgency_class: classification.class,
    ai_summary: description,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  await supabase.from('leads').insert(lead);

  // Alert if urgent
  if (classification.class === 'urgent') {
    const message = `URGENT FORM LEAD\nName: ${name}\nPhone: ${phone}\nService: ${service_type}\nLocation: ${location}\nDescription: ${description}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'alerts@yourdomain.com', to: tenant.owner_email, subject: `URGENT FORM LEAD — ${name}`, text: message })
    }).catch(() => {});

    await fetch(`https://wasenderapi.com/api/send-message`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: process.env.WASENDER_SESSION_ID, to: tenant.owner_whatsapp, text: message })
    }).catch(() => {});
  }

  return res.status(200).json({ success: true, urgency: classification.class });
}
