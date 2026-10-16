import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),invalidate:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks}));
vi.mock('@/providers/UserProvider',()=>({useUser:()=>({user:{systemRole:'ADMIN'}})}));
vi.mock('@/lib/useApiQuery',()=>({invalidateApiCache:mocks.invalidate}));
import {SearchPresetSection} from './SearchPresetSection';
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockResolvedValue({searchProfile:null,brief:''});});
it('previews an export before applying it and refreshes the shared firm settings',async()=>{
 const applied=vi.fn(),answers={firmName:'Example Search',thesis:'Profitable services in the UK.',currency:'GBP'};
 mocks.post.mockResolvedValue({searchProfile:{answers,updatedAt:'2030-01-01'},brief:'Example Search',warnings:['GBP ranges preserved.']});
 render(<SearchPresetSection onApplied={applied}/>);
 const file=new File(['{}'],'search.json',{type:'application/json'});Object.defineProperty(file,'text',{value:async()=>JSON.stringify({answers})});
 fireEvent.change(screen.getByLabelText('Search profile JSON file'),{target:{files:[file]}});
 await screen.findByText('Example Search');expect(mocks.post).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Apply search presets'}));
 await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/firm-context/search-preset',{answers}));
 await screen.findByText('Search presets saved.');expect(applied).toHaveBeenCalledOnce();expect(mocks.invalidate).toHaveBeenCalledWith('/users/me');
});
it('does not allow a skipped workspace to seed empty firm settings',async()=>{
 render(<SearchPresetSection onApplied={vi.fn()}/>);
 const file=new File(['{}'],'search.json');Object.defineProperty(file,'text',{value:async()=>JSON.stringify({setupStatus:'skipped',answers:{firmName:'',thesis:''}})});
 fireEvent.change(screen.getByLabelText('Search profile JSON file'),{target:{files:[file]}});
 await screen.findByText('Finish the saved search setup before importing its profile.');expect(mocks.post).not.toHaveBeenCalled();
});
