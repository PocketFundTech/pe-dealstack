import { Router } from 'express';
import { getOrgId } from '../middleware/orgScope.js';
import { searchAnswersSchema } from '../services/searchPreset.js';
import { applySearchPreset, getSearchPreset, saveSearchDraft } from '../services/searchPresetService.js';
import { searchDraftSchema } from '../services/searchSetup.js';
import { logFromRequest, AUDIT_ACTIONS, RESOURCE_TYPES } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
const router = Router();
// Inherits authentication, organization scope, MFA and API-key scope from /firm-context.
router.get('/search-preset', async (req,res,next) => {
  try { res.json(await getSearchPreset(getOrgId(req))); } catch (error) { next(error); }
});
router.post('/search-preset', async (req,res,next) => {
  if (req.user?.role?.toUpperCase() !== 'ADMIN' || req.user?.apiKeyId) return res.status(403).json({error:'Sign in as a workspace admin to apply firm-wide search presets.'});
  const parsed = searchAnswersSchema.safeParse(req.body?.answers);
  if (!parsed.success) return res.status(400).json({error:'Complete the search profile before importing it.',details:parsed.error.flatten()});
  try {
    const orgId = getOrgId(req);
    const result = await applySearchPreset(orgId,parsed.data);
    log.info('Firm search presets applied',{orgId,userId:req.user.id});
    await logFromRequest(req,AUDIT_ACTIONS.SETTINGS_CHANGED,{resourceType:RESOURCE_TYPES.SETTINGS,resourceId:orgId,description:'Applied firm search presets'}).catch(error=>log.warn('Search preset audit write failed',{orgId,error:String(error)}));
    res.json(result);
  } catch (error) { next(error); }
});
for (const action of ['draft','skip'] as const) {
  router.post(`/search-setup/${action}`, async (req,res,next) => {
    if (req.user?.role?.toUpperCase() !== 'ADMIN' || req.user?.apiKeyId) return res.status(403).json({error:'Sign in as a workspace admin to save firm-wide search setup.'});
    const parsed = searchDraftSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({error:'Invalid search draft.',details:parsed.error.flatten()});
    try { res.json(await saveSearchDraft(getOrgId(req),parsed.data,action === 'skip')); }
    catch(error) { next(error); }
  });
}
export default router;
