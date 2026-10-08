#!/usr/bin/env node
/**
 * Avise API-key lifecycle test: webhooks (validation, create, ping, delete),
 * read_only key enforcement, session-only key management, revocation.
 * Complements api-key-smoke-test.mjs (endpoint sweep).
 *
 *   FULLKEY=avise_sk_… TE=admin@example.com TP=password \
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… API_BASE=http://localhost:3101 \
 *   node apps/api/tools/api-key-lifecycle-test.mjs
 *
 * Mints a temporary read_only key (revoked at the end). Webhook tests use
 * https://example.com only; no organization data leaves the machine.
 */
const B=(process.env.API_BASE||'http://localhost:3101'), FULL=process.env.FULLKEY;
const log=[];const t=(n,ok,d='')=>{log.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  → '+d:''}`)};
const call=async(m,p,{key=FULL,tok,body}={})=>{const h={};if(key)h.Authorization='Bearer '+key;if(tok)h.Authorization='Bearer '+tok;if(body)h['Content-Type']='application/json';const r=await fetch(B+p,{method:m,headers:h,body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json()}catch{}return{s:r.status,j}};
// ---- webhooks (full key, admin)
let r=await call('POST','/api/webhook-subscriptions',{body:{url:'http://example.com/h',events:['deal.created']}});t('webhook http:// rejected',r.s===400,r.j?.error);
r=await call('POST','/api/webhook-subscriptions',{body:{url:'https://localhost/h',events:['deal.created']}});t('webhook localhost rejected',r.s===400,r.j?.error);
r=await call('POST','/api/webhook-subscriptions',{body:{url:'https://10.0.0.5/h',events:['deal.created']}});t('webhook private IP rejected',r.s===400);
r=await call('POST','/api/webhook-subscriptions',{body:{url:'https://example.com/h',events:['deal.nope']}});t('webhook bad event rejected',r.s===400);
r=await call('POST','/api/webhook-subscriptions',{body:{url:'https://example.com/avise-qa',events:['deal.created','deal.stage_changed'],description:'QA-API-TEST'}});
const wid=r.j?.webhook?.id;t('webhook create 201 + secret once',r.s===201&&!!r.j?.secret&&!!wid,`secretLen=${r.j?.secret?.length}`);
r=await call('GET','/api/webhook-subscriptions');t('webhook list hides secret',r.s===200&&!JSON.stringify(r.j).includes('"secret"'));
if(wid){r=await call('POST',`/api/webhook-subscriptions/${wid}/test`);t('webhook ping delivery attempted',r.s===200||r.s===502||r.s===400,JSON.stringify(r.j).slice(0,160));
r=await call('PATCH',`/api/webhook-subscriptions/${wid}`,{body:{active:false}});t('webhook pause',r.s===200);
r=await call('DELETE',`/api/webhook-subscriptions/${wid}`);t('webhook delete',[200,204].includes(r.s));
r=await call('GET','/api/webhook-subscriptions');t('webhook gone after delete',!JSON.stringify(r.j).includes(wid));}
// ---- read_only key
const L=await fetch(process.env.SUPABASE_URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:process.env.TE,password:process.env.TP})});
const tok=(await L.json()).access_token;
r=await call('POST','/api/api-keys',{key:null,tok,body:{name:'claude-ro-test (temp)',scope:'read_only',expiresInDays:30}});
const ro=r.j?.key,rid=r.j?.apiKey?.id;t('mint read_only key via session',r.s===201&&r.j?.apiKey?.scope==='read_only',r.j?.error);
if(ro){
 r=await call('GET','/api/deals?limit=1',{key:ro});t('RO key can GET',r.s===200);
 for(const [m,p,b] of [['POST','/api/companies',{name:'QA-API-TEST ro'}],['POST','/api/deals',{name:'QA-API-TEST ro',companyName:'x'}],['PATCH','/api/users/me',{name:'x'}],['DELETE','/api/deals/00000000-0000-0000-0000-000000000000'],['POST','/api/webhook-subscriptions',{url:'https://example.com/h',events:['deal.created']}]]){
  r=await call(m,p,{key:ro,body:b});t(`RO key blocked ${m} ${p}`,r.s===403,`status ${r.s} ${r.j?.error||''}`.slice(0,120));}
 r=await call('GET','/api/api-keys',{key:ro});t('RO key cannot list keys',r.s===403);
 r=await call('GET','/api/api-keys',{key:null,tok});const listed=JSON.stringify(r.j);t('session lists keys, no plaintext',r.s===200&&!listed.includes(ro));
 r=await call('DELETE',`/api/api-keys/${rid}`,{key:null,tok});t('revoke RO key via session',[200,204].includes(r.s),`status ${r.s}`);
 r=await call('GET','/api/deals?limit=1',{key:ro});t('revoked key now 401',r.s===401);
 r=await call('DELETE',`/api/api-keys/${rid}`,{key:ro});t('(revoked key cannot manage keys)',[401,403].includes(r.s));
}
r=await call('DELETE','/api/api-keys/'+(rid||'x'),{key:FULL});t('full key cannot revoke keys',r.s===403);
console.log(`\n${log.filter(Boolean).length}/${log.length} passed`);
