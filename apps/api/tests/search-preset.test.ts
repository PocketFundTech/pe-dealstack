import { describe,it,expect,vi,beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
const state=vi.hoisted(()=>({settings:null as Record<string,unknown>|null,writes:[] as Record<string,unknown>[],orgs:[] as string[],conflict:false,readError:false,role:'ADMIN',apiKey:false}));
vi.mock('../src/supabase.js',()=>({supabase:{from:()=>{
  let row:Record<string,unknown>|undefined;
  const chain:any={select:()=>chain,eq:(k:string,v:string)=>{if(k==='id')state.orgs.push(v);return chain;},is:()=>chain,
    single:async()=>({data:{settings:structuredClone(state.settings)},error:state.readError?{message:'DB down'}:null}),
    update:(v:Record<string,unknown>)=>{row=v;return chain;},maybeSingle:async()=>{
      if(state.conflict){state.conflict=false;state.settings={...state.settings,concurrentSetting:'keep'};return {data:null,error:null};}
      state.writes.push(row!);state.settings=row!.settings as Record<string,unknown>;return {data:{id:'org-A'},error:null};
    }};return chain;
}}}));
vi.mock('../src/utils/logger.js',()=>({log:{info:vi.fn(),error:vi.fn(),warn:vi.fn()}}));
vi.mock('../src/middleware/orgScope.js',()=>({getOrgId:()=> 'org-A'}));
import {searchAnswersSchema,buildSearchPreset,searchPresetContext} from '../src/services/searchPreset.js';
vi.mock('../src/services/auditLog.js',()=>({logFromRequest:vi.fn().mockResolvedValue(undefined),AUDIT_ACTIONS:{SETTINGS_CHANGED:'SETTINGS_CHANGED'},RESOURCE_TYPES:{SETTINGS:'SETTINGS'}}));
vi.mock('../src/services/llm.js',()=>({getChatModel:vi.fn()}));
import {getFirmContextBlock} from '../src/services/firmContextService.js';
import router from '../src/routes/firm-search-preset.js';
const raw={thesis:'Profitable B2B service businesses with recurring revenue.',firmName:'Example Search',website:'example.com',buyerType:'Traditional search fund',teamSize:'1–5',sectorsInclude:['Business services'],geographies:['United States'],currency:'USD',ebitdaMin:1,ebitdaMax:3,dealSizeMin:5,dealSizeMax:15,timeline:'Actively reviewing deals',fundingStage:'Capital committed',features:['Other'],otherCriteria:'Multi-year contracts',sources:['Broker / adviser inbound'],firstFocus:'Screen incoming deals'};
function app(){const a=express();a.use(express.json());a.use((req:any,_res,next)=>{req.user={id:'auth-A',role:state.role,...(state.apiKey?{apiKeyId:'key-A'}:{})};next();});a.use(router);a.use((e:any,_req:any,res:any,_next:any)=>res.status(e.statusCode||500).json({error:e.message}));return a;}
beforeEach(()=>{state.settings=null;state.writes=[];state.orgs=[];state.conflict=false;state.readError=false;state.role='ADMIN';state.apiKey=false;});
describe('search presets',()=>{
 it('seeds relevant fields while preserving unrelated settings and distinguishing EV from AUM',()=>{
  const a=searchAnswersSchema.parse(raw);const result=buildSearchPreset({billing:{plan:'paid'},firmProfile:{aum:'$250M',headquarters:'London'}},a);
  expect(result.settings.firmProfile).toMatchObject({aum:'$250M',headquarters:'London',firmName:'Example Search',sectorFocus:['Business services'],teamSize:'1–5',website:'https://example.com'});
  expect(result.settings.dealCriteria).toMatchObject({ebitdaMin:1,dealSizeMin:5});
  expect(result.settings.billing).toEqual({plan:'paid'});expect(result.brief).toContain('Preferences: Multi-year contracts');
  expect(searchPresetContext(result.settings)).toContain('EBITDA: USD 1–3 million');
 });
 it('retains existing firm context and criteria and never converts non-USD numbers silently',()=>{
  const existing={firmContext:{text:'Existing house view'},dealCriteria:{ebitdaMin:12},firmProfile:{firmName:'Existing firm'}};
  const result=buildSearchPreset(existing,searchAnswersSchema.parse({...raw,currency:'INR'}));
  expect(result.settings.dealCriteria).toEqual(existing.dealCriteria);expect(result.settings.firmContext).toEqual(existing.firmContext);expect(result.settings.firmProfile.firmName).toBe('Existing firm');
  const fresh=buildSearchPreset({},searchAnswersSchema.parse({...raw,currency:'INR'}));
  expect(fresh.settings.dealCriteria).toMatchObject({ebitdaMin:null,dealSizeMin:null});expect(fresh.settings.searchProfile.answers.ebitdaMax).toBe(3);expect(fresh.warnings[0]).toContain('INR');
 });
 it.each(['firmName','website','timeline','fundingStage'])('requires %s',field=>{expect(searchAnswersSchema.safeParse({...raw,[field]:''}).success).toBe(false);});
 it('rejects inverted ranges',()=>{expect(searchAnswersSchema.safeParse({...raw,ebitdaMin:10}).success).toBe(false);});
 it('includes the full imported profile and current criteria in the AI consumption hook',async()=>{
  state.settings=buildSearchPreset({firmContext:{text:'Existing house view'},dealCriteria:{ebitdaMin:12}},searchAnswersSchema.parse(raw)).settings;
  const block=await getFirmContextBlock('org-A');expect(block).toContain('Existing house view');expect(block).toContain('Capital readiness: Capital committed');expect(block).toContain('Multi-year contracts');expect(block).toContain('\"ebitdaMin\":12');
 });
 it('applies and reads a complete profile through org-scoped routes',async()=>{
  const result=await request(app()).post('/search-preset').send({answers:raw});expect(result.status).toBe(200);expect(state.orgs.every(org=>org==='org-A')).toBe(true);
  const read=await request(app()).get('/search-preset');expect(read.body.searchProfile.answers.firmName).toBe(raw.firmName);
 });
 it('retries a concurrent settings change without losing it',async()=>{
  state.settings={untouched:true};state.conflict=true;
  expect((await request(app()).post('/search-preset').send({answers:raw})).status).toBe(200);
  expect(state.settings).toMatchObject({untouched:true,concurrentSetting:'keep'});expect(state.writes).toHaveLength(1);
 });
 it('does not write when the settings read fails',async()=>{state.readError=true;expect((await request(app()).post('/search-preset').send({answers:raw})).status).toBe(500);expect(state.writes).toHaveLength(0);});
 it.each(['MEMBER','VIEWER'])('denies %s from changing firm-wide presets',async role=>{state.role=role;expect((await request(app()).post('/search-preset').send({answers:raw})).status).toBe(403);expect(state.writes).toHaveLength(0);});
 it('rejects API-key callers',async()=>{state.apiKey=true;expect((await request(app()).post('/search-preset').send({answers:raw})).status).toBe(403);});
});

describe('integrated search setup',()=>{
 const draft=()=>({step:'brief',touched:['thesis'],answers:{...searchAnswersSchema.parse(raw),thesis:'Still thinking',firmName:'',website:'',buyerType:'',timeline:'',fundingStage:''}});
 it('saves an incomplete draft without changing firm context, resumes it, then skips without inventing a profile',async()=>{
  state.settings={firmContext:{text:'Keep this'},billing:{plan:'paid'}};
  expect((await request(app()).post('/search-setup/draft').send(draft())).status).toBe(200);
  let read=await request(app()).get('/search-preset');
  expect(read.body.searchSetup).toMatchObject({status:'draft',draft:{answers:{thesis:'Still thinking'}}});expect(read.body.searchProfile).toBeNull();
  expect((await request(app()).post('/search-setup/skip').send(draft())).status).toBe(200);
  read=await request(app()).get('/search-preset');expect(read.body.searchSetup.status).toBe('skipped');
  expect(state.settings).toMatchObject({firmContext:{text:'Keep this'},billing:{plan:'paid'}});
  expect(state.settings?.firmProfile).toBeUndefined();
 });
 it('completes profile and setup status in the same write, and rejects stale draft saves afterwards',async()=>{
  await request(app()).post('/search-setup/skip').send(draft());
  const result=await request(app()).post('/search-preset').send({answers:raw});
  expect(result.status).toBe(200);expect(result.body.searchSetup).toMatchObject({status:'complete',draft:null});
  expect(state.settings).toMatchObject({searchSetup:{status:'complete',draft:null},firmProfile:{firmName:raw.firmName}});
  expect((await request(app()).post('/search-setup/draft').send(draft())).status).toBe(409);
  expect((await request(app()).post('/search-setup/skip').send(draft())).status).toBe(409);
 });
 it('does not reset a skipped state when resuming a draft',async()=>{
  await request(app()).post('/search-setup/skip').send(draft());
  await request(app()).post('/search-setup/draft').send({...draft(),step:'team'});
  expect((await request(app()).get('/search-preset')).body.searchSetup).toMatchObject({status:'skipped',draft:{step:'team'}});
 });
 it.each(['draft','skip'])('rejects malformed %s payloads and honors organization boundaries',async action=>{
  expect((await request(app()).post(`/search-setup/${action}`).send({step:'invalid',answers:{}})).status).toBe(400);
  expect(state.writes).toHaveLength(0);
  expect((await request(app()).post(`/search-setup/${action}`).send({...draft(),organizationId:'org-B'})).status).toBe(200);
  expect(state.orgs.every(id=>id==='org-A')).toBe(true);
 });
 it.each(['MEMBER','VIEWER'])('denies %s from saving or skipping firm setup',async role=>{
  state.role=role;
  for(const action of ['draft','skip'])expect((await request(app()).post(`/search-setup/${action}`).send(draft())).status).toBe(403);
  expect(state.writes).toHaveLength(0);
 });
 it('denies API-key draft writes',async()=>{state.apiKey=true;expect((await request(app()).post('/search-setup/draft').send(draft())).status).toBe(403);});
 it('accepts M&A Advisor and normalizes old Advisor exports',()=>{
  expect(searchAnswersSchema.parse({...raw,buyerType:'M&A Advisor'}).buyerType).toBe('M&A Advisor');
  expect(searchAnswersSchema.parse({...raw,buyerType:'Advisor'}).buyerType).toBe('M&A Advisor');
 });
});
