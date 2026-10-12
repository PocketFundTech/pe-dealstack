import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

interface LinkRow {
  role: string;
  contact: { id: string; firstName: string; lastName: string; email: string | null; title: string | null; company: string | null } | null;
}

/**
 * GET /api/deals/:dealId/contacts — contacts linked to a deal (ContactDeal),
 * oldest link first. Org-scoped; another org's deal is a 404.
 */
router.get('/:dealId/contacts', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    if (!(await verifyDealAccess(dealId, getOrgId(req)))) return res.status(404).json({ error: 'Deal not found' });
    const { data, error } = await supabase
      .from('ContactDeal')
      .select('role, createdAt, contact:Contact(id, firstName, lastName, email, title, company)')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: true });
    if (error) throw error;
    const contacts = ((data ?? []) as unknown as LinkRow[])
      .filter((r) => r.contact)
      .map((r) => ({ ...r.contact!, role: r.role }));
    res.json({ contacts });
  } catch (err) {
    log.error('GET deal contacts failed', err);
    res.status(500).json({ error: 'Could not load this deal\'s contacts' });
  }
});

export default router;
