import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks}));
vi.mock('@/providers/UserProvider',()=>({useUser:()=>({user:{systemRole:'ADMIN'}})}));
import {ApiKeysSection} from './ApiKeysSection';
import {expiryPayload} from './api-key-expiry';
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockResolvedValue({apiKeys:[]});mocks.post.mockResolvedValue({key:'avise_sk_test_only',apiKey:{id:'k1',name:'Test',scope:'full',keyPrefix:'avise_sk_test',lastFour:'only',expiresAt:'2035-02-03T12:30:00Z',revokedAt:null}});});
describe('API key expiry controls',()=>{
 it('submits a calendar date and local time as an exact UTC instant',async()=>{
  render(<ApiKeysSection onToast={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Key name'),{target:{value:'Calendar test'}});
  fireEvent.change(screen.getByLabelText('Expires'),{target:{value:'custom'}});
  fireEvent.change(screen.getByLabelText('Expiry date'),{target:{value:'2035-02-03'}});
  fireEvent.change(screen.getByLabelText('Expiry time'),{target:{value:'12:30'}});
  fireEvent.click(screen.getByRole('button',{name:'Create key'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/api-keys',{name:'Calendar test',scope:'full',expiresAt:new Date('2035-02-03T12:30:00').toISOString()}));
 });
 it('keeps presets and never sends a stale calendar date when switching back',async()=>{
  render(<ApiKeysSection onToast={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Key name'),{target:{value:'Preset'}});
  fireEvent.change(screen.getByLabelText('Expires'),{target:{value:'custom'}});
  fireEvent.change(screen.getByLabelText('Expiry date'),{target:{value:'2035-02-03'}});
  fireEvent.change(screen.getByLabelText('Expires'),{target:{value:'7'}});
  expect(screen.queryByLabelText('Expiry date')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Create key'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/api-keys',{name:'Preset',scope:'full',expiresInDays:7}));
 });
 it('rejects past and missing dates without creating a key',async()=>{
  const toast=vi.fn();render(<ApiKeysSection onToast={toast}/>);
  fireEvent.change(screen.getByLabelText('Key name'),{target:{value:'Invalid'}});
  fireEvent.change(screen.getByLabelText('Expires'),{target:{value:'custom'}});
  fireEvent.click(screen.getByRole('button',{name:'Create key'}));
  await waitFor(()=>expect(toast).toHaveBeenCalledWith('Choose an expiry date and time.','error'));expect(mocks.post).not.toHaveBeenCalled();
  expect(()=>expiryPayload('custom','2020-01-01','12:00')).toThrow('future');
  expect(()=>expiryPayload('custom','2035-02-30','12:00')).toThrow('valid date');
 });
});
