import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) return res.status(401).end();

  const { tenant_id, action } = req.body;
  if (!tenant_id || !['freeze','unfreeze'].includes(action)) return res.status(400).end();

  const { error } = await supabase
    .from('clients')
    .update({ status: action === 'freeze' ? 'frozen' : 'active' })
    .eq('tenant_id', tenant_id);

  if (error) return res.status(500).json({ error: 'Failed' });
  return res.status(200).json({ success: true });
}
