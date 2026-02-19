const { supabase, verifyOwner } = require('./_utils');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { tenant_id, secret_key, action, lead_id, updates } = req.body;
  const owner = await verifyOwner(tenant_id, secret_key);

  if (!owner) return res.status(401).json({ error: 'Invalid credentials' });
  if (owner.frozen) return res.status(403).json({ error: 'frozen' });

  // GET ALL DASHBOARD DATA
  if (action === 'get') {
    const [leadsRes, contactsRes] = await Promise.all([
      supabase.from('leads').select('*')
        .eq('tenant_id', tenant_id)
        .neq('status', 'done') // Hide done leads from main view
        .order('created_at', { ascending: false }),
      supabase.from('contacts').select('*')
        .eq('tenant_id', tenant_id)
        .order('created_at', { ascending: false })
    ]);

    return res.status(200).json({
      leads: leadsRes.data || [],
      contacts: contactsRes.data || [],
      owner
    });
  }

  // MARK LEAD AS DONE (disappears from dashboard, stays in contacts)
  if (action === 'done' && lead_id) {
    await supabase.from('leads').update({ status: 'done' })
      .eq('id', lead_id)
      .eq('owner_id', owner.id); // security: can only mark own leads
    return res.status(200).json({ ok: true });
  }

  // UPDATE SETTINGS
  if (action === 'settings' && updates) {
    const allowed = ['service_area', 'radius_miles', 'job_types', 'min_job_value', 'timezone', 'phone'];
    const safe = {};
    for (const k of allowed) {
      if (updates[k] !== undefined) safe[k] = updates[k];
    }
    await supabase.from('owners').update(safe).eq('id', owner.id);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
