'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Logo } from '@/components/layout/Logo';
import { invalidateApiCache } from '@/lib/useApiQuery';
import { STEPS, emptyAnswers, normalizeAnswers, validateStep, validateAll, suggestedName } from './schema.js';
import { parseBrief } from './brief-parser.js';
import { StepContent } from './steps';
import type { Draft, Field, Change, SetupResponse, Step } from './types';
import styles from './search-setup.module.css';

function initialDraft(initial:SetupResponse,storageKey:string):Draft {
  const saved=initial.searchSetup?.draft;
  let draft:Draft=saved?{...saved,answers:normalizeAnswers(saved.answers)}:{answers:normalizeAnswers(initial.searchProfile?.answers||emptyAnswers()),step:initial.searchProfile?'review':'brief',touched:initial.searchProfile?Object.keys(initial.searchProfile.answers) as Field[]:[]};
  try {
    const local=JSON.parse(sessionStorage.getItem(storageKey)||'null');
    const serverDate=initial.searchSetup?.updatedAt||initial.searchProfile?.updatedAt||'';
    if(local?.draft?.answers && local.updatedAt>serverDate && STEPS.some(([s])=>s===local.draft.step))draft={...local.draft,answers:normalizeAnswers(local.draft.answers),touched:Array.isArray(local.draft.touched)?local.draft.touched:[]};
  } catch { /* Server draft remains available when browser storage is blocked. */ }
  return draft;
}
export function SearchSetup({initial,storageKey,fromSettings=false}:{initial:SetupResponse;storageKey:string;fromSettings?:boolean}) {
  const router=useRouter();
  const [draft,setDraft]=useState(()=>initialDraft(initial,storageKey));
  const [error,setError]=useState('');
  const [saveError,setSaveError]=useState('');
  const [saveState,setSaveState]=useState('');
  const [busy,setBusy]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [returnToReview,setReturnToReview]=useState(false);
  const queue=useRef<Promise<unknown>>(Promise.resolve());
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const terminal=useRef(false);
  const form=useRef<HTMLFormElement>(null);
  const persistDraft=initial.searchSetup?.status!=='complete';
  const index=STEPS.findIndex(([s])=>s===draft.step);
  function update(next:Draft) {
    setDraft(next);setDirty(true);setError('');
    try {sessionStorage.setItem(storageKey,JSON.stringify({draft:next,updatedAt:new Date().toISOString()}));} catch { /* API save is the primary persistence. */ }
  }
  const change:Change=(field,value)=>setDraft(previous=>{
    const next={...previous,answers:{...previous.answers,[field]:value},touched:[...new Set([...previous.touched,field])]};
    setDirty(true);setError('');
    try {sessionStorage.setItem(storageKey,JSON.stringify({draft:next,updatedAt:new Date().toISOString()}));} catch { /* API save remains available. */ }
    return next;
  });
  function enqueue(snapshot:Draft) {
    setSaveState('Saving…');setSaveError('');
    queue.current=queue.current.catch(()=>{}).then(()=>api.post('/firm-context/search-setup/draft',snapshot)).then(()=>setSaveState('Draft saved')).catch(err=>{setSaveState('');setSaveError(err instanceof Error?err.message:'Could not save your draft.');});
    return queue.current;
  }
  useEffect(()=>{
    if(!dirty||busy||!persistDraft||terminal.current)return;
    timer.current=setTimeout(()=>{void enqueue(draft);},500);
    return ()=>{if(timer.current)clearTimeout(timer.current);};
  },[draft,dirty,busy,persistDraft]);
  useEffect(()=>{
    form.current?.querySelector<HTMLElement>('h1')?.focus();
    form.current?.scrollIntoView?.({block:'start'});
  },[draft.step]);
  function move(step:Step) {update({...draft,step});}
  function next() {
    const problem=validateStep(draft.step,draft.answers);
    if(problem){setError(problem);return;}
    if(draft.step==='review'){void finish(false);return;}
    let answers={...draft.answers};
    if(draft.step==='brief') {
      const inferred=parseBrief(answers.thesis);
      for(const key of Object.keys(inferred) as Field[])if(key!=='thesis'&&!draft.touched.includes(key))Object.assign(answers,{[key]:inferred[key]});
    }
    const step=returnToReview?'review':STEPS[index+1][0];
    if(step==='review'&&!answers.searchName)answers={...answers,searchName:suggestedName(answers)};
    setReturnToReview(false);update({...draft,answers,step});
  }
  async function finish(skip:boolean) {
    if(terminal.current)return;
    if(!skip){const problem=validateAll(draft.answers);if(problem){move(problem.step);setError(problem.error);return;}}
    terminal.current=true;setBusy(true);setError('');
    if(timer.current)clearTimeout(timer.current);
    try {
      await queue.current.catch(()=>{});
      if(skip && persistDraft)await api.post('/firm-context/search-setup/skip',draft);
      if(!skip)await api.post('/firm-context/search-preset',{answers:draft.answers});
      try {sessionStorage.removeItem(storageKey);sessionStorage.setItem('pe_onboarding_seen','1');} catch { /* Saved server state prevents onboarding loops. */ }
      invalidateApiCache('/users/me');
      router.replace(fromSettings?'/settings#section-search-profile':'/dashboard');
    } catch(err) {terminal.current=false;setBusy(false);setError(err instanceof Error?err.message:'Could not save. Please try again.');}
  }
  return <div className={styles.shell}><div className="onboarding">
    <header className="topbar"><span className="logo"><Logo className="brand-mark"/>avise</span><span className="header-caption">Search setup</span><div className="topbar-right"><span className="draft-status" role="status">{persistDraft?saveState:'Changes save when you finish'}</span>{index>0&&<button type="button" className="text-link" disabled={busy} onClick={()=>void finish(true)}>{initial.searchProfile?'Cancel':'Skip for now'}</button>}</div></header>
    <main className="setup-main"><form ref={form} className="step-content" noValidate onSubmit={e=>{e.preventDefault();if(!busy)next();}}>
      <div className="setup-progress"><span className="progress-caption">{STEPS[index][1]}</span><span className="progress-count">Step {index+1} of {STEPS.length}</span><div className="progress-track" role="progressbar" aria-label="Search setup" aria-valuemin={1} aria-valuemax={9} aria-valuenow={index+1}>{STEPS.map(([s],i)=><span key={s} className={i<=index?'reached':''}/>)}</div></div>
      <fieldset disabled={busy} style={{margin:0}}><StepContent step={draft.step} answers={draft.answers} touched={draft.touched} change={change} edit={step=>{setReturnToReview(true);move(step);}}/></fieldset>
      {draft.step==='review'&&draft.answers.currency!=='USD'&&<p className="soft-note">Your {draft.answers.currency} ranges stay in the search profile. Investment Criteria uses USD; enter converted values there when ready.</p>}
      <div id="form-error" role="alert">{error}</div>
      {saveError&&<p className="save-error" role="alert">{saveError} <button type="button" disabled={busy} onClick={()=>void enqueue(draft)}>Retry save</button></p>}
      <div className="step-actions"><button className="primary" style={{backgroundColor:'#003366'}} disabled={busy} type="submit">{busy?'Saving…':draft.step==='review'?'Save and open workspace':returnToReview?'Back to review':'Continue'} <span aria-hidden="true">→</span></button>
      {index===0&&<button type="button" className="skip-setup" disabled={busy} onClick={()=>void finish(true)}>Skip for now</button>}
      <div className="step-navigation">{index>0?<button type="button" className="back-button" disabled={busy} onClick={()=>{move(returnToReview?'review':STEPS[index-1][0]);setReturnToReview(false);}}>← Back</button>:<span>About 4 minutes</span>}</div></div>
    </form></main><footer className="setup-footer"><span>Your search. Your criteria.</span><span>You can update this in Settings.</span></footer>
  </div></div>;
}
