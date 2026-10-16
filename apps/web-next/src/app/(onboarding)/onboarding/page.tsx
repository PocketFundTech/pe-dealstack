'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { useUser } from '@/providers/UserProvider';
import { api } from '@/lib/api';
import { SearchSetup } from '@/components/search-setup/SearchSetup';
import type { SetupResponse } from '@/components/search-setup/types';
import type { OnboardingStatus } from './types';
import LegacyOnboarding from './legacy-onboarding';

export default function OnboardingPage() {
  const router=useRouter();
  const search=useSearchParams();
  const fromSettings=search.get('search')==='1';
  const {user:authUser,loading:authLoading}=useAuth();
  const {user,loading:userLoading,refetch}=useUser();
  const [view,setView]=useState<'loading'|'legacy'|'search'>('loading');
  const [initial,setInitial]=useState<SetupResponse|null>(null);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(authLoading)return;
    if(!authUser){router.replace('/login');return;}
    if(userLoading)return;
    if(!user?.organization?.id)return;
    let cancelled=false;
    async function load() {
      setError('');setView('loading');
      try {
        const status=await api.get<OnboardingStatus>('/onboarding/status');
        if(cancelled)return;
        if(user?.systemRole!=='ADMIN'||status.context?.invited){setView('legacy');return;}
        const preset=await api.get<SetupResponse>('/firm-context/search-preset');
        if(cancelled)return;
        const finished=preset.searchSetup?.status==='complete'||preset.searchSetup?.status==='skipped'||!!preset.searchProfile;
        const existing=!preset.searchSetup&&(status.welcomeShown||status.checklistDismissed||Object.values(status.steps||{}).some(Boolean));
        if(!fromSettings&&(finished||existing)){router.replace('/dashboard');return;}
        setInitial(preset);setView('search');
      } catch(err) {if(!cancelled)setError(err instanceof Error?err.message:'Could not load search setup. Please retry.');}
    }
    void load();
    return ()=>{cancelled=true;};
  },[authLoading,authUser,user,userLoading,fromSettings,retry,router]);
  const loadError=error||(!authLoading&&authUser&&!userLoading&&!user?.organization?.id?'Your workspace is not ready yet. Retry in a moment.':'');
  if(loadError)return <main className="mx-auto max-w-lg p-8 pt-24"><h1 className="text-2xl font-semibold">Search setup</h1><p role="alert" className="mt-4 text-sm text-red-700">{loadError}</p><button type="button" onClick={()=>{void refetch();setRetry(v=>v+1);}} className="mt-6 rounded-lg px-5 py-3 text-white" style={{backgroundColor:'#003366'}}>Retry</button></main>;
  if(view==='legacy')return <LegacyOnboarding/>;
  if(view==='search'&&initial&&user)return <SearchSetup key={`${user.id}:${user.organization?.id}`} initial={initial} storageKey={`pe-search-setup:${user.id}:${user.organization?.id}`} fromSettings={fromSettings}/>;
  return <p role="status" className="p-12 text-center text-sm text-text-secondary">Loading your search setup…</p>;
}
