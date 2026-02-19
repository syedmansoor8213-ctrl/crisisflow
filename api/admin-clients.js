import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Admin auth
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { filter, search } = req.query;

  let query = supabase
    .from('clients')
    .select('tenant_id, secret_key, business_name, owner_name, owner_email, owner_phone, service_types, service_location, referral_code, salesperson_id, status, created_at, ads_running, google_business, website')
    .order('created_at', { ascending: false });

  // Date filter
  const now = new Date();
  if (filter === 'today') {
    const start = new Date(now); start.setHours(0,0,0,0);
    query = query.gte('created_at', start.toISOString());
  } else if (filter === 'week') {
    const start = new Date(now); start.setDate(start.getDate()-7);
    query = query.gte('created_at', start.toISOString());
  } else if (filter === 'month') {
    const start = new Date(now); start.setMonth(start.getMonth()-1);
    query = query.gte('created_at', start.toISOString());
  } else if (filter === 'year') {
    const start = new Date(now); start.setFullYear(start.getFullYear()-1);
    query = query.gte('created_at', start.toISOString());
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed' });

  // Search filter (done in JS for simplicity)
  let results = data;
  if (search) {
    const s = search.toLowerCase();
    results = data.filter(c =>
      c.tenant_id?.toLowerCase().includes(s) ||
      c.owner_email?.toLowerCase().includes(s) ||
      c.secret_key?.toLowerCase().includes(s) ||
      c.referral_code?.toLowerCase().includes(s) ||
      c.business_name?.toLowerCase().includes(s)
    );
  }

  return res.status(200).json({ clients: results });
}
