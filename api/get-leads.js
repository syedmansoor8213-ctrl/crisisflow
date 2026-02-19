import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { tenant_id, secret_key, filter, tab } = req.query;

  if (!tenant_id || !secret_key) return res.status(401).json({ error: 'Unauthorized' });

  // Verify ownership
  const { data: tenant } = await supabase
    .from('clients')
    .select('tenant_id, status')
    .eq('tenant_id', tenant_id)
    .eq('secret_key', secret_key.toUpperCase())
    .single();

  if (!tenant) return res.status(401).json({ error: 'Unauthorized' });
  if (tenant.status === 'frozen') return res.status(403).json({ error: 'Account suspended' });

  let query = supabase
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant_id)
    .order('created_at', { ascending: false });

  // Date filter
  const now = new Date();
  if (filter === 'today') {
    const start = new Date(now); start.setHours(0,0,0,0);
    query = query.gte('created_at', start.toISOString());
  } else if (filter === 'yesterday') {
    const start = new Date(now); start.setDate(start.getDate()-1); start.setHours(0,0,0,0);
    const end = new Date(now); end.setHours(0,0,0,0);
    query = query.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
  } else if (filter === '3days') {
    const start = new Date(now); start.setDate(start.getDate()-3);
    query = query.gte('created_at', start.toISOString());
  } else if (filter === '7days') {
    const start = new Date(now); start.setDate(start.getDate()-7);
    query = query.gte('created_at', start.toISOString());
  }

  // Tab filter
  if (tab && tab !== 'all') {
    query = query.eq('urgency_class', tab);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to fetch' });

  return res.status(200).json({ leads: data });
}
