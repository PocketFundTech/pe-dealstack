import { Router } from 'express';
import type { Request } from 'express';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

// ─── GET /api/contacts/insights/timeline — Recent interactions across all contacts ─

router.get('/insights/timeline', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    // Get contact IDs for this org, then filter interactions
    const { data: orgContacts } = await supabase
      .from('Contact')
      .select('id')
      .eq('organizationId', orgId);
    const contactIds = (orgContacts || []).map((c: any) => c.id);

    if (contactIds.length === 0) {
      return res.json({ interactions: [] });
    }

    const { data: interactions, error } = await supabase
      .from('ContactInteraction')
      .select('*, Contact:contactId(id, firstName, lastName, type, company)')
      .in('contactId', contactIds)
      .order('date', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ interactions: interactions || [] });
  } catch (error) {
    log.error('Timeline error', error);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// ─── GET /api/contacts/insights/duplicates — Find duplicate contacts ─

router.get('/insights/duplicates', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    const { data: contacts, error } = await supabase
      .from('Contact')
      .select('id, firstName, lastName, email, company, type')
      .eq('organizationId', orgId)
      .order('firstName', { ascending: true });

    if (error) throw error;

    const duplicates: { key: string; reason: string; contacts: any[] }[] = [];
    const emailMap = new Map<string, any[]>();
    const nameMap = new Map<string, any[]>();

    for (const c of contacts || []) {
      // Group by email
      if (c.email) {
        const key = c.email.toLowerCase().trim();
        if (!emailMap.has(key)) emailMap.set(key, []);
        emailMap.get(key)!.push(c);
      }
      // Group by full name
      const nameKey = `${(c.firstName || '').toLowerCase().trim()} ${(c.lastName || '').toLowerCase().trim()}`;
      if (nameKey.trim()) {
        if (!nameMap.has(nameKey)) nameMap.set(nameKey, []);
        nameMap.get(nameKey)!.push(c);
      }
    }

    // Collect email duplicates
    for (const [email, group] of emailMap) {
      if (group.length > 1) {
        duplicates.push({ key: email, reason: 'Same email', contacts: group });
      }
    }

    // Collect name duplicates (only if not already caught by email)
    const seenIds = new Set(duplicates.flatMap(d => d.contacts.map((c: any) => c.id)));
    for (const [name, group] of nameMap) {
      if (group.length > 1 && !group.every((c: any) => seenIds.has(c.id))) {
        duplicates.push({ key: name, reason: 'Same name', contacts: group });
      }
    }

    res.json({ duplicates, count: duplicates.length });
  } catch (error) {
    log.error('Duplicates error', error);
    res.status(500).json({ error: 'Failed to check duplicates' });
  }
});

// ─── GET /api/contacts/insights/stale — Contacts needing attention ─

router.get('/insights/stale', async (req: Request, res) => {
  try {
    const daysThreshold = Number(req.query.days) || 30;
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();

    const orgId = getOrgId(req);

    // Contacts where lastContactedAt is before cutoff or null
    const { data: staleContacted, error: err1 } = await supabase
      .from('Contact')
      .select('id, firstName, lastName, type, company, email, lastContactedAt')
      .eq('organizationId', orgId)
      .lt('lastContactedAt', cutoff)
      .order('lastContactedAt', { ascending: true })
      .limit(20);

    const { data: neverContacted, error: err2 } = await supabase
      .from('Contact')
      .select('id, firstName, lastName, type, company, email, lastContactedAt, createdAt')
      .eq('organizationId', orgId)
      .is('lastContactedAt', null)
      .order('createdAt', { ascending: true })
      .limit(20);

    if (err1) throw err1;
    if (err2) throw err2;

    const stale = [
      ...(neverContacted || []).map((c: any) => ({ ...c, reason: 'Never contacted' })),
      ...(staleContacted || []).map((c: any) => ({ ...c, reason: `No contact in ${Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86400000)} days` })),
    ];

    res.json({ contacts: stale, threshold: daysThreshold });
  } catch (error) {
    log.error('Stale contacts error', error);
    res.status(500).json({ error: 'Failed to check stale contacts' });
  }
});

// ─── GET /api/contacts/insights/scores — Relationship strength scores ─

router.get('/insights/scores', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    // Fetch all contacts for this org
    const { data: contacts, error: cErr } = await supabase
      .from('Contact')
      .select('id, lastContactedAt')
      .eq('organizationId', orgId);
    if (cErr) throw cErr;

    // Scope to org contacts only
    const contactIds = (contacts || []).map((c: any) => c.id);
    if (contactIds.length === 0) {
      return res.json({ scores: {} });
    }

    // Count interactions per contact (org-scoped)
    const { data: interactions, error: iErr } = await supabase
      .from('ContactInteraction')
      .select('contactId')
      .in('contactId', contactIds);
    if (iErr) throw iErr;

    // Count linked deals per contact (org-scoped)
    const { data: dealLinks, error: dErr } = await supabase
      .from('ContactDeal')
      .select('contactId')
      .in('contactId', contactIds);
    if (dErr) throw dErr;

    const interactionCounts: Record<string, number> = {};
    for (const i of interactions || []) {
      interactionCounts[i.contactId] = (interactionCounts[i.contactId] || 0) + 1;
    }

    const dealCounts: Record<string, number> = {};
    for (const d of dealLinks || []) {
      dealCounts[d.contactId] = (dealCounts[d.contactId] || 0) + 1;
    }

    const now = Date.now();
    const scores: Record<string, any> = {};

    for (const c of contacts || []) {
      // Recency score (0-40)
      let recency = 0;
      if (c.lastContactedAt) {
        const days = (now - new Date(c.lastContactedAt).getTime()) / 86400000;
        if (days <= 7) recency = 40;
        else if (days <= 14) recency = 35;
        else if (days <= 30) recency = 28;
        else if (days <= 60) recency = 18;
        else if (days <= 90) recency = 10;
        else if (days <= 180) recency = 5;
      }

      // Frequency score (0-40)
      const iCount = interactionCounts[c.id] || 0;
      let frequency = 0;
      if (iCount >= 20) frequency = 40;
      else if (iCount >= 12) frequency = 35;
      else if (iCount >= 8) frequency = 28;
      else if (iCount >= 5) frequency = 22;
      else if (iCount >= 3) frequency = 15;
      else if (iCount >= 1) frequency = 8;

      // Deals score (0-20)
      const dCount = dealCounts[c.id] || 0;
      let deals = 0;
      if (dCount >= 4) deals = 20;
      else if (dCount >= 3) deals = 16;
      else if (dCount >= 2) deals = 12;
      else if (dCount >= 1) deals = 8;

      const score = recency + frequency + deals;
      let label = 'Cold';
      if (score > 75) label = 'Strong';
      else if (score > 50) label = 'Active';
      else if (score > 25) label = 'Warm';

      scores[c.id] = { score, label, breakdown: { recency, frequency, deals } };
    }

    res.json({ scores });
  } catch (error) {
    log.error('Scores error', error);
    res.status(500).json({ error: 'Failed to compute scores' });
  }
});

// ─── GET /api/contacts/insights/network — Network overview stats ─

router.get('/insights/network', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    const { data: contacts, error: cErr } = await supabase
      .from('Contact')
      .select('id, firstName, lastName, type, company')
      .eq('organizationId', orgId);
    if (cErr) throw cErr;

    // Scope to org contacts only
    const contactIds = (contacts || []).map((c: any) => c.id);
    if (contactIds.length === 0) {
      return res.json({ totalContacts: 0, byType: {}, totalConnections: 0, mostConnected: [] });
    }

    // ContactRelationship table may not exist yet — gracefully default to empty (org-scoped)
    let connections: any[] = [];
    const { data: connData, error: rErr } = await supabase
      .from('ContactRelationship')
      .select('contactId, relatedContactId')
      .in('contactId', contactIds);
    if (!rErr) connections = connData || [];

    const { data: dealLinks, error: dErr } = await supabase
      .from('ContactDeal')
      .select('contactId')
      .in('contactId', contactIds);
    if (dErr) throw dErr;

    // Type breakdown
    const byType: Record<string, number> = {};
    for (const c of contacts || []) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }

    // Count connections + deals per contact
    const linkCount: Record<string, number> = {};
    for (const r of connections || []) {
      linkCount[r.contactId] = (linkCount[r.contactId] || 0) + 1;
      linkCount[r.relatedContactId] = (linkCount[r.relatedContactId] || 0) + 1;
    }
    for (const d of dealLinks || []) {
      linkCount[d.contactId] = (linkCount[d.contactId] || 0) + 1;
    }

    // Top 5 most connected
    const contactMap = new Map((contacts || []).map((c: any) => [c.id, c]));
    const ranked = Object.entries(linkCount)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 5)
      .map(([id, total]) => {
        const c = contactMap.get(id) || {} as any;
        return {
          id,
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          type: c.type || 'OTHER',
          company: c.company || '',
          totalLinks: total,
        };
      });

    res.json({
      totalContacts: (contacts || []).length,
      byType,
      totalConnections: (connections || []).length,
      mostConnected: ranked,
    });
  } catch (error) {
    log.error('Network stats error', error);
    res.status(500).json({ error: 'Failed to load network stats' });
  }
});

export default router;
