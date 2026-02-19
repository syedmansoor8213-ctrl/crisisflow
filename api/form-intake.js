const { supabase, qualify, sendEmergencySMS, saveLead } = require('./_utils');

module.exports = async (req, res) => {
  // Allow form to be embedded on any website
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { tenant_id, name, phone, address, problem, urgency_score } = req.body;
  if (!tenant_id || !name || !phone || !problem) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const { data: owner } = await supabase
    .from('owners')
    .select('*')
    .eq('tenant_id', tenant_id)
    .eq('status', 'active')
    .single();

  if (!owner) return res.status(404).json({ error: 'Not found' });

  // Build input for Gemini from form fields
  const input = `Name: ${name}. Phone: ${phone}. Address: ${address}. Problem: ${problem}. Urgency they rated: ${urgency_score || 5}/10.`;
  const result = await qualify(input, owner);

  // First-level check: wrong area or wrong job type → instant sorry
  if (!result.in_area || !result.right_job_type) {
    return res.status(200).json({ qualified: false, reason: 'out_of_scope' });
  }

  const lead = await saveLead(owner, {
    name: result.name || name,
    phone: result.phone || phone,
    address: result.address || address,
    problem: result.problem || problem,
    urgency: result.urgency,
    value_min: result.value_min,
    value_max: result.value_max,
    channel: 'form'
  });

  if (result.urgency === 'emergency') {
    await sendEmergencySMS(owner, { ...result, ...lead });
  }

  return res.status(200).json({
    qualified: result.urgency !== 'junk',
    urgency: result.urgency,
    in_area: result.in_area,
    right_job_type: result.right_job_type
  });
};
