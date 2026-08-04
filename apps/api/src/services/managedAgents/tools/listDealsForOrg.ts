import { supabase } from '../../../supabase.js';

export interface ListedDeal {
  id: string;
  name: string;
  industry: string | null;
  stage: string;
  revenue: number | null;
  company: string | null;
}

export async function listDealsForOrg(organizationId: string, _input: unknown): Promise<{ deals: ListedDeal[] }> {
  const { data, error } = await supabase
    .from('Deal')
    .select('id, name, industry, stage, revenue, Company(name)')
    .eq('organizationId', organizationId)
    .neq('status', 'PASSED')
    .neq('stage', 'CLOSED_LOST')
    .order('updatedAt', { ascending: false })
    .limit(30);

  if (error || !data) return { deals: [] };

  return {
    deals: data.map((d: any) => ({
      id: d.id,
      name: d.name,
      industry: d.industry ?? null,
      stage: d.stage,
      revenue: d.revenue ?? null,
      company: d.Company?.name ?? null,
    })),
  };
}
