import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
/**
 * Find user by authId (or legacy id), or create if not exists.
 * On first signup: also creates the Organization if firmName is provided.
 */
export async function findOrCreateUser(authUser: {
  id: string;
  email: string;
  name?: string;
  firmName?: string;
  role: string;
  user_metadata?: Record<string, unknown>;
}) {
  // Try to find by authId first (include Organization join)
  let { data: userData, error } = await supabase
    .from('User')
    .select('*, organization:Organization(id, name, slug, logo, plan)')
    .eq('authId', authUser.id)
    .single();

  // If not found by authId, try by id (legacy users)
  if (error?.code === 'PGRST116') {
    const result = await supabase
      .from('User')
      .select('*, organization:Organization(id, name, slug, logo, plan)')
      .eq('id', authUser.id)
      .single();
    userData = result.data;
    error = result.error;
  }

  // If still not found, create the user (+ Organization if needed)
  if (error?.code === 'PGRST116') {
    const title = authUser.user_metadata?.title as string | undefined;
    let organizationId: string | null = null;

    // Create the Organization from firmName.
    // SECURITY: never attach a new signup to an EXISTING organization by name.
    // firmName comes from user-controlled signup metadata (user_metadata.firm_name),
    // so matching an existing org by name would let an attacker join another
    // tenant's organization simply by signing up with that firm's name. Every
    // fresh signup creates its own org; teammates join an existing org only via
    // the invitation flow (which carries the real organizationId).
    if (authUser.firmName) {
      const baseSlug = authUser.firmName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 100) || 'org';
      const mkSlug = () => `${baseSlug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      // The slug carries a timestamp + random suffix, so collisions are near
      // impossible; on the rare 23505 we retry with a fresh slug rather than
      // ever falling back to a name lookup.
      let orgRow: { id: string } | null = null;
      for (let attempt = 0; attempt < 3 && !orgRow; attempt++) {
        const { data, error: orgError } = await supabase
          .from('Organization')
          .insert({ name: authUser.firmName, slug: mkSlug() })
          .select('id')
          .single();
        if (!orgError && data) {
          orgRow = data;
          break;
        }
        if (orgError && orgError.code !== '23505') {
          log.error('Failed to create organization', orgError);
          throw orgError;
        }
      }
      if (!orgRow) {
        throw new Error('Failed to create organization after repeated slug collisions');
      }
      organizationId = orgRow.id;
      log.info('Organization created on signup', { orgId: orgRow.id, name: authUser.firmName });
      // Sample deal is created during onboarding (POST /api/onboarding/create-demo-deal),
      // not auto-created on signup.
    }

    const { data: newUser, error: createError } = await supabase
      .from('User')
      .insert({
        authId: authUser.id,
        email: authUser.email,
        name: authUser.name || authUser.email?.split('@')[0] || 'User',
        role: authUser.role || 'MEMBER',
        title: title || null,
        firmName: authUser.firmName || null,
        organizationId,
        isActive: true,
      })
      .select('*, organization:Organization(id, name, slug, logo, plan)')
      .single();

    if (createError) {
      // Race resolution: another concurrent request just inserted this User row.
      if (createError.code === '23505') {
        const { data: existing } = await supabase
          .from('User')
          .select('*, organization:Organization(id, name, slug, logo, plan)')
          .eq('authId', authUser.id)
          .single();
        if (existing) {
          log.info('User race resolved — using existing record', { authId: authUser.id });
          return existing;
        }
      }
      throw createError;
    }

    // Set createdBy on Organization if this is the founding user
    if (organizationId) {
      await supabase
        .from('Organization')
        .update({ createdBy: newUser.id })
        .eq('id', organizationId)
        .is('createdBy', null);
    }

    return newUser;
  }

  if (error) throw error;
  return userData;
}
