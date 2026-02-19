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

  // ─── STEP 1: KEYWORD PRE-CHECK ───
  const urgencyKeywords = [
    'emergency', 'urgent', 'immediately', 'right now', 'asap',
    'quickly', 'hurry', 'please help', 'desperate', 'serious',
    'really bad', 'flooding', 'no power', 'locked out', 'burst',
    'stranded', 'critical', 'dangerous', 'help me', 'please',
    'bad', 'worst', 'severe', 'quick', 'fast', 'now', 'today',
    'cant wait', "can't wait", 'need someone', 'need help'
  ];

  const descLower = (description || '').toLowerCase();
  const hasUrgencyKeyword = urgencyKeywords.some(kw => descLower.includes(kw));

  let classification;

  if (hasUrgencyKeyword) {
    classification = { class: 'urgent', reason: 'urgency keywords detected' };
    console.log('Keyword match — classified urgent instantly');
  } else {
    // ─── STEP 2: GEMINI FOR AMBIGUOUS CASES ───
    const prompt = `You are a lead urgency classifier for a local service business.

Business serves: ${tenant.service_types.join(', ')}
Business location: ${tenant.service_location}
Caller name: ${name}
Service requested: ${service_type}
Their location: ${location}
Their description: ${description}

Classify as URGENT if ANY of these are true:
- Tone sounds distressed or panicked
- Could cause damage or safety risk if not fixed soon
- AC or heating failure in extreme weather
- No power, no heat, no cooling
- Active leaking, flooding, or water damage
- Locked out right now
- Vehicle stranded

Classify as QUALIFIED if:
- Real job, right service, right location, no urgency signals

Classify as JUNK if:
- Wrong location, wrong service, spam, not a real job

Respond ONLY with valid JSON, nothing else:
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

      const geminiData = await response.json();
      const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('Gemini raw response:', text);

      if (text.includes('"urgent"')) {
        classification = { class: 'urgent', reason: 'gemini urgent' };
      } else if (text.includes('"junk"')) {
        classification = { class: 'junk', reason: 'gemini junk' };
      } else {
        classification = { class: 'qualified', reason: 'gemini qualified' };
      }
    } catch (err) {
      console.error('Gemini failed:', err);
      classification = { class: 'qualified', reason: 'gemini error fallback' };
    }
  }

  // ─── STEP 3: SAVE LEAD ───
  const lead = {
    tenant_id,
    source: 'form',
    caller_name: name || 'Unknown',
    caller_phone: phone,
    callback_phone: phone,
    job_type: service_type || 'General',
    location: location || null,
    urgency_class: classification.class,
    ai_summary: description,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  const { error: leadError } = await supabase.from('leads').insert(lead);
  if (leadError) console.error('Lead insert error:', leadError);

  // ─── STEP 4: SAVE TO CAMPAIGN CONTACTS IMMEDIATELY ───
  if (name && phone) {
    const { error: ccError } = await supabase.from('campaign_contacts').insert({
      tenant_id,
      name: name,
      phone: phone,
      service_type: service_type || 'General',
      source: 'form'
    });
    if (ccError) console.error('Campaign contact error:', ccError);
  }

  // ─── STEP 5: ALERT IF URGENT ───
  if (classification.class === 'urgent') {
    const message = `URGENT FORM LEAD\nName: ${name}\nPhone: ${phone}\nService: ${service_type}\nLocation: ${location}\nDescription: ${description}`;

    // Format WhatsApp number for WaSender
    const waNumber = (tenant.owner_whatsapp || '')
      .replace(/\+/g, '')
      .replace(/\s/g, '')
      .replace(/-/g, '') + '@s.whatsapp.net';

    // Resend email (primary)
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'RingReady Alerts <onboarding@resend.dev>',
        to: tenant.owner_email,
        subject: `🚨 URGENT LEAD — ${name}`,
        text: message
      })
    }).catch(e => console.error('Resend failed:', e));
    if (emailRes) {
      const emailData = await emailRes.json().catch(() => {});
      console.log('Resend response:', JSON.stringify(emailData));
    }

    // WaSender WhatsApp (backup)
    const waRes = await fetch('https://wasenderapi.com/api/send-message', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: process.env.WASENDER_SESSION_ID,
        to: waNumber,
        text: message
      })
    }).catch(e => console.error('WaSender failed:', e));
    if (waRes) {
      const waData = await waRes.json().catch(() => {});
      console.log('WaSender response:', JSON.stringify(waData));
    }
  }

  return res.status(200).json({ success: true, urgency: classification.class });
}
