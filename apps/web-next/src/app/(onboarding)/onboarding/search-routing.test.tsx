import {beforeEach,it,expect,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
const mock=vi.hoisted(()=>({get:vi.fn(),router:{replace:vi.fn()},auth:{user:{id:'auth-A'} as {id:string}|null,loading:false},app:{user:{id:'user-A',systemRole:'ADMIN',organization:{id:'org-A'}},loading:false,refetch:vi.fn()},search:false}));
vi.mock('next/navigation',()=>({useRouter:()=>mock.router,useSearchParams:()=>new URLSearchParams(mock.search?'search=1':'')}));
vi.mock('@/lib/api',()=>({api:{get:mock.get}}));
vi.mock('@/providers/AuthProvider',()=>({useAuth:()=>mock.auth}));
vi.mock('@/providers/UserProvider',()=>({useUser:()=>mock.app}));
vi.mock('./legacy-onboarding',()=>({default:()=> <p>Teammate checklist</p>}));
vi.mock('@/components/search-setup/SearchSetup',()=>({SearchSetup:({storageKey}:{storageKey:string})=><p>Nine-step search setup {storageKey}</p>}));
import OnboardingPage from './page';
beforeEach(()=>{vi.clearAllMocks();mock.auth.user={id:'auth-A'};mock.app.user.systemRole='ADMIN';mock.search=false;mock.get.mockImplementation(async(path:string)=>path==='/onboarding/status'?{context:{isAdmin:true,invited:false},steps:{}}:{searchProfile:null,searchSetup:null,brief:''});});
it('routes a fresh signup admin into the search flow with workspace-specific draft storage',async()=>{
 render(<OnboardingPage/>);expect(await screen.findByText('Nine-step search setup pe-search-setup:user-A:org-A')).toBeInTheDocument();
});
it('preserves the teammate onboarding flow for invited admins',async()=>{
 mock.get.mockResolvedValue({context:{isAdmin:true,invited:true}});render(<OnboardingPage/>);await screen.findByText('Teammate checklist');expect(mock.get).not.toHaveBeenCalledWith('/firm-context/search-preset');
});
it('keeps nonadmins out of firm-wide setup',async()=>{mock.app.user.systemRole='MEMBER';render(<OnboardingPage/>);await screen.findByText('Teammate checklist');});
it.each(['complete','skipped'])('sends %s setups to the dashboard on ordinary visits',async status=>{
 mock.get.mockImplementation(async(path:string)=>path==='/onboarding/status'?{context:{isAdmin:true}}:{searchProfile:null,searchSetup:{status},brief:''});
 render(<OnboardingPage/>);await waitFor(()=>expect(mock.router.replace).toHaveBeenCalledWith('/dashboard'));
});
it('allows explicit Settings resume even after skipping',async()=>{
 mock.search=true;mock.get.mockImplementation(async(path:string)=>path==='/onboarding/status'?{context:{isAdmin:true},welcomeShown:true}:{searchProfile:null,searchSetup:{status:'skipped'},brief:''});
 render(<OnboardingPage/>);await screen.findByText(/Nine-step search setup/);expect(mock.router.replace).not.toHaveBeenCalled();
});
it('does not force existing users through the new flow',async()=>{
 mock.get.mockImplementation(async(path:string)=>path==='/onboarding/status'?{context:{isAdmin:true},welcomeShown:true}:{searchProfile:null,searchSetup:null,brief:''});
 render(<OnboardingPage/>);await waitFor(()=>expect(mock.router.replace).toHaveBeenCalledWith('/dashboard'));
});
it('keeps a failed profile load retryable instead of opening an empty form',async()=>{
 mock.get.mockRejectedValue(new Error('Cannot load workspace'));render(<OnboardingPage/>);await screen.findByText('Cannot load workspace');expect(screen.getByRole('button',{name:'Retry'})).toBeInTheDocument();expect(screen.queryByText(/Nine-step search setup/)).not.toBeInTheDocument();
});
it('sends unauthenticated visitors to login without fetching firm data',async()=>{
 mock.auth.user=null;render(<OnboardingPage/>);await waitFor(()=>expect(mock.router.replace).toHaveBeenCalledWith('/login'));expect(mock.get).not.toHaveBeenCalled();
});
