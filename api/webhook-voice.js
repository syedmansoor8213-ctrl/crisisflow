import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function classifyWithGemini(tenant, summary, caller_name, job_type) {
  const prompt = `You are a lead qualification engine for a local service business.

Business serves: ${tenant.service_types.join(', ')}
Business location: ${tenant.service_location}
Caller name: ${caller_name || 'Unknown'}
Call label from AI receptionist: ${job_type || 'Unknown'}
Call summary: ${summary || 'No summary provided'}

Classify this lead into exactly one category:
- urgent: active emergency, caller needs someone immediately (flooding, no power, locked out right now, gas leak, burst pipe)
- qualified: real job, matches service type and location, not an emergency
- junk: wrong service, wrong location, spam, solicitation, or not a real job

Respond ONLY with valid JSON, nothing else:
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

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"class":"qualified","reason":"could not classify"}';

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { class: 'qualified', reason: 'parse error fallback' };
  }
}

async function sendUrgentAlerts(tenant, lead) {
  const message = `URGENT LEAD\nBusiness: ${tenant.business_name}\nCaller: ${lead.caller_name || 'Unknown'}\nPhone: ${lead.callback_phone || lead.caller_phone}\nJob: ${lead.job_type}\nSummary: ${lead.ai_summary}`;

  // Resend email
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'alerts@yourdomain.com',
        to: tenant.owner_email,
        subject: `URGENT LEAD — ${lead.caller_name || 'Unknown Caller'}`,
        text: message
      })
    });
  } catch (e) {
    console.error('Resend failed:', e);
  }

  // WaSender WhatsApp
  try {
    await fetch(`https://wasenderapi.com/api/send-message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: process.env.WASENDER_SESSION_ID,
        to: tenant.owner_whatsapp,
        text: message
      })
    });
  } catch (e) {
    console.error('WaSender failed:', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Respond 200 immediately so ring-ready doesn't retry
  res.status(200).json({ received: true });

  const tenant_id = req.query.tenant_id;
  if (!tenant_id) return;

  const {
    from_phone_number, callback_number,
    caller_name, call_label, summary
  } = req.body;

  // Fetch tenant
  const { data: tenant, error } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenant_id)
    .single();

  if (error || !tenant) return;
  if (tenant.status === 'frozen') return;

  // Classify
  const classification = await classifyWithGemini(
    tenant, summary, caller_name, call_label
  );

  // Save lead
  const lead = {
    tenant_id,
    source: 'call',
    caller_name: caller_name || 'Unknown',
    caller_phone: from_phone_number,
    callback_phone: callback_number || from_phone_number,
    job_type: call_label || 'General Inquiry',
    urgency_class: classification.class,
    ai_summary: summary || 'No summary',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  await supabase.from('leads').insert(lead);

  // Alert only if urgent
  if (classification.class === 'urgent') {
    await sendUrgentAlerts(tenant, lead);
  }
}
