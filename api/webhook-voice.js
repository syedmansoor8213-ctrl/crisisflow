import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

Business serves: ${tenant.service_types ? tenant.service_types.join(', ') : 'General Services'}
Business location: ${tenant.service_location || 'Local Area'}
Caller name: ${caller_name || 'Unknown'}
Call label: ${job_type || 'Unknown'}
Call summary: ${summary || 'No summary'}

Classify as URGENT if:
- Active emergency, caller needs someone immediately
- Flooding, no power, locked out, gas leak, burst pipe, or total AC failure in heat
- Tone sounds distressed or panicked

Classify as QUALIFIED if:
- Real job, matches service type and location, but not an immediate emergency

Classify as JUNK if:
- Wrong service, wrong location (far from ${tenant.service_location}), spam, or a hang-up

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
    
    if (text.includes('"urgent"')) return { class: 'urgent', reason: 'gemini detected crisis' };
    if (text.includes('"junk"')) return { class: 'junk', reason: 'out of scope or spam' };
    return { class: 'qualified', reason: 'valid lead' };

  } catch (err) {
    console.error('Gemini classification error:', err);
    return { class: 'qualified', reason: 'fallback after error' };
  }
}

export default async function handler(req, res) {
  // 1. Immediate Response to RingReady
  if (req.method !== 'POST') return res.status(405).end();
  res.status(200).json({ received: true });

  const { tenant_id } = req.query;
  if (!tenant_id) {
    console.error('Missing tenant_id');
    return;
  }

  const {
    from_phone_number,
    callback_number,
    caller_name,
    call_label,
    summary
  } = req.body;

  // 2. Fetch Tenant Settings
  const { data: tenant, error: tenantError } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenant_id)
    .single();

  if (tenantError || !tenant || tenant.status === 'frozen') {
    console.error('Tenant unavailable:', tenant_id);
    return;
  }

  // 3. Extract Location from Summary (e.g., "in Islamabad")
  // Searches for the word after "in" or "at", or defaults to the tenant's primary city
  const locationRegex = /(?:in|at|near|location:)\s+([A-Z][a-z]+)/i;
  const match = summary?.match(locationRegex);
  const extractedLocation = match ? match[1] : (tenant.service_location || 'Unknown');

  // 4. Urgency Classification
  const hasUrgency = checkUrgencyKeywords(summary);
  let classification;

  if (hasUrgency) {
    classification = { class: 'urgent', reason: 'Keyword trigger' };
  } else {
    classification = await classifyWithGemini(tenant, summary, caller_name, call_label);
  }

  // 5. Save Lead to Supabase
  const leadData = {
    tenant_id,
    source: 'call',
    caller_name: caller_name || 'Unknown',
    caller_phone: from_phone_number || null,
    callback_phone: callback_number || from_phone_number || null,
    job_type: call_label || 'General Inquiry',
    location: extractedLocation,
    urgency_class: classification.class,
    ai_summary: summary || 'No summary provided',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  const { error: leadInsertError } = await supabase.from('leads').insert(leadData);
  if (leadInsertError) console.error('Error saving lead:', leadInsertError);

  // 6. Add to Campaign Contacts (if valid contact info exists)
  const finalPhone = callback_number || from_phone_number;
  if (finalPhone && caller_name !== 'Unknown') {
    const { error: contactError } = await supabase.from('campaign_contacts').insert({
      tenant_id,
      name: caller_name,
      phone: finalPhone,
      service_type: call_label || 'General',
      source: 'call'
    });
    if (contactError) console.error('Error saving campaign contact:', contactError);
  }
}
