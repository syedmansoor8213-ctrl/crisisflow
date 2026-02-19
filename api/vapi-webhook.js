const crypto = require('crypto');
const { supabase, qualify, sendEmergencySMS, saveLead } = require('./_utils');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify this request is actually from Vapi
  const incoming = Buffer.from(req.headers['x-vapi-secret'] || '');
  const expected = Buffer.from(process.env.VAPI_WEBHOOK_SECRET || '');
  if (incoming.length !== expected.length || !crypto.timingSafeEqual(incoming, expected)) {
    return res.status(401).end();
  }

  // Only care about end-of-call reports
  if (req.body?.type !== 'end-of-call-report') {
    return res.status(200).json({ ok: true });
  }

  const transcript = req.body?.transcript || '';
  const assistantId = req.body?.call?.assistantId;
  if (!transcript || !assistantId) return res.status(200).json({ ok: true });

  // Find which owner this assistant belongs to
  const { data: owner } = await supabase
    .from('owners')
    .select('*')
    .eq('vapi_assistant_id', assistantId)
    .eq('status', 'active')
    .single();

  if (!owner) return res.status(200).json({ no_owner: true });

  // Qualify with Gemini
  const result = await qualify(transcript, owner);

  const lead = await saveLead(owner, {
    name: result.name,
    phone: result.phone,
    address: result.address,
    problem: result.problem,
    urgency: result.urgency,
    value_min: result.value_min,
    value_max: result.value_max,
    channel: 'call',
    transcript
  });

  // Only send SMS for true emergencies
  if (result.urgency === 'emergency') {
    await sendEmergencySMS(owner, { ...result, ...lead });
  }

  return res.status(200).json({ ok: true, urgency: result.urgency });
};
