import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── KEYWORD PRE-CHECK (same logic as form) ───
function checkUrgencyKeywords(text) {
  const urgencyKeywords = [
    'emergency', 'urgent', 'immediately', 'right now', 'asap',
    'quickly', 'hurry', 'please help', 'desperate', 'serious',
    'really bad', 'flooding', 'no power', 'locked out', 'burst',
    'stranded', 'critical', 'dangerous', 'help me', 'please',
    'bad', 'worst', 'severe', 'quick', 'fast', 'now', 'today',
    'cant wait', "can't wait", 'need someone', 'need help',
    'leaking', 'water everywhere', 'smoke', 'sparking', 'fire',
    'gas leak', 'no heat', 'no cooling', 'broken into', 'stuck'
  ];
  const lower = (text || '').toLowerCase();
  return urgencyKeywords.some(kw => lower.includes(kw));
}

async function classifyWithGemini(tenant, summary, caller_name, job_type) {
  const prompt = `You are a lead urgency classifier for a local service business.

Business serves: ${tenant.service_types.join(', ')}
Business location: ${tenant.service_location}
Caller name: ${caller_name || 'Unknown'}
Call label: ${job_type || 'Unknown'}
Call summary: ${summary || 'No summary'}

Classify as URGENT if:
- Active emergency, caller needs someone immediately
- Flooding, no power, locked out, gas leak, burst pipe
- Tone sounds distressed or panicked
- Could cause damage or safety risk if not fixed soon

Classify as QUALIFIED if:
- Real job, matches service type and location, not emergency

Classify as JUNK if:
- Wrong service, wrong location, spam, not a real job

Respond ONLY with valid JSON:
{"class": "urgent", "reason": "brief reason"}`;

  try {
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
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Gemini voice response:', text);

    if (text.includes('"urgent"')) return { class: 'urgent', reason: 'gemini urgent' };
    if (text.includes('"junk"')) return { class: 'junk', reason: 'gemini junk' };
    return { class: 'qualified', reason: 'gemini qualified' };

  } catch (err) {
    console.error('Gemini failed:', err);
    return { class: 'qualified', reason: 'gemini error fallback' };
  }
}

async function sendUrgentAlerts(tenant, lead) {
  const message = `URGENT CALL LEAD\nBusiness: ${tenant.business_name}\nCaller: ${lead.caller_name}\nPhone: ${lead.callback_phone || lead.caller_phone}\nJob: ${lead.job_type}\nSummary: ${lead.ai_summary}`;

  // Resend email (primary)
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'alerts@yourdomain.com',
      to: tenant.owner_email,
      subject: `URGENT CALL — ${lead.caller_name}`,
      text: message
    })
  }).catch(e => console.error('Resend failed:', e));

  // WaSender WhatsApp (backup)
  await fetch('https://wasenderapi.com/api/send-message', {
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
  }).catch(e => console.error('WaSender failed:', e));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Respond 200 immediately so ring-ready doesn't retry
  res.status(200).json({ received: true });

  const tenant_id = req.query.tenant_id;
  if (!tenant_id) {
    console.error('No tenant_id in webhook URL');
    return;
  }

  console.log('Webhook received for tenant:', tenant_id);
  console.log('Webhook body:', JSON.stringify(req.body));

  const {
    from_phone_number,
    callback_number,
    caller_name,
    call_label,
    summary
  } = req.body;

  // ─── FETCH TENANT ───
  const { data: tenant, error } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenant_id)
    .single();

  if (error || !tenant) {
    console.error('Tenant not found:', tenant_id);
    return;
  }

  if (tenant.status === 'frozen') {
    console.log('Tenant is frozen, skipping:', tenant_id);
    return;
  }

  // ─── CLASSIFY ───
  // Keyword check on summary first — faster and free
  const hasUrgency = checkUrgencyKeywords(summary);
  let classification;

  if (hasUrgency) {
    classification = { class: 'urgent', reason: 'urgency keywords in call summary' };
    console.log('Keyword match on call summary — urgent');
  } else {
    classification = await classifyWithGemini(tenant, summary, caller_name, call_label);
  }

  console.log('Classification result:', classification);

  // ─── SAVE LEAD ───
  const lead = {
    tenant_id,
    source: 'call',
    caller_name: caller_name || 'Unknown',
    caller_phone: from_phone_number || null,
    callback_phone: callback_number || from_phone_number || null,
    job_type: call_label || 'General Inquiry',
    location: null,
    urgency_class: classification.class,
    ai_summary: summary || 'No summary provided',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  const { error: leadError } = await supabase.from('leads').insert(lead);
  if (leadError) console.error('Lead insert error:', leadError);
  else console.log('Lead saved successfully');

  // ─── SAVE TO CAMPAIGN CONTACTS IMMEDIATELY ───
  const contactName = caller_name || 'Unknown';
  const contactPhone = callback_number || from_phone_number;

  if (contactPhone && contactName !== 'Unknown') {
    const { error: ccError } = await supabase.from('campaign_contacts').insert({
      tenant_id,
      name: contactName,
      phone: contactPhone,
      service_type: call_label || 'General',
      source: 'call'
    });
    if (ccError) console.error('Campaign contact error:', ccError);
    else console.log('Campaign contact saved');
  }

  // ─── ALERT IF URGENT ───
  if (classification.class === 'urgent') {
    console.log('Sending urgent alerts for tenant:', tenant.business_name);
    await sendUrgentAlerts(tenant, lead);
  }
}
