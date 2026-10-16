import { useState, type ReactNode } from 'react';
import { OPTIONS } from './schema.js';
import { COUNTRIES } from './countries.js';
import type { Answers, Change, ListField, TextField, BoolField, MoneyField } from './types';
export interface FieldsProps { answers: Answers; change: Change }
export function Group({title,note,children}:{title:string;note?:string;children:ReactNode}) {
  return <fieldset><legend>{title}{note && <span>{note}</span>}</legend>{children}</fieldset>;
}
export function TextInput({field,label,answers,change,placeholder,max=1000}:{field:TextField;label:string;placeholder?:string;max?:number}&FieldsProps) {
  return <div className="field"><label htmlFor={field}>{label}</label><input id={field} value={answers[field]} maxLength={max} placeholder={placeholder} onChange={e=>change(field,e.target.value)} /></div>;
}
export function Toggle({field,label,note,answers,change}:{field:BoolField;label:string;note:string}&FieldsProps) {
  return <label className="check-row"><input type="checkbox" checked={answers[field]} onChange={e=>change(field,e.target.checked)}/><span><strong>{label}</strong><small>{note}</small></span></label>;
}
export function Choices({field,answers,change,options,single=false,cards=false}:{field:ListField|TextField;options?:string[];single?:boolean;cards?:boolean}&FieldsProps) {
  const values=options ?? OPTIONS[field as keyof typeof OPTIONS] ?? [];
  function select(value:string) {
    if(single) {change(field as TextField,value);return;}
    const current=answers[field] as string[];
    let next=current.includes(value)?current.filter(v=>v!==value):[...current,value];
    if(field==='transactionTypes' && next.includes('Open to structure'))next=value==='Open to structure'?['Open to structure']:next.filter(v=>v!=='Open to structure');
    change(field as ListField,next);
    if(field==='sectorsInclude')change('sectorOpen',false);
    if(field==='geographies')change('locationFlexible',false);
  }
  return <div className={cards?'choice-cards':'chips'} aria-label={field}>{values.map(value=>{
    const selected=single?answers[field]===value:(answers[field] as string[]).includes(value);
    return <button type="button" key={value} className={`${cards?'choice-card':'chip'}${selected?' selected':''}`} aria-pressed={selected} onClick={()=>select(value)}>
      {cards?<span className="choice-radio" aria-hidden="true">{selected&&<i/>}</span>:selected?<span aria-hidden="true">✓</span>:null}{cards?<strong>{value}</strong>:value}
    </button>;
  })}</div>;
}
export function SelectField({field,label,answers,change,placeholder}:{field:'timeline'|'fundingStage';label:string;placeholder:string}&FieldsProps) {
  return <div className="field"><label htmlFor={field}>{label}</label><select id={field} value={answers[field]} onChange={e=>change(field,e.target.value)}><option value="">{placeholder}</option>{OPTIONS[field].map(v=><option key={v}>{v}</option>)}</select></div>;
}
export function SectorInput({answers,change}:FieldsProps) {
  const [value,setValue]=useState('');
  function add() {const v=value.trim().slice(0,100);if(v && !answers.sectorsInclude.includes(v)){change('sectorsInclude',[...answers.sectorsInclude,v]);change('sectorOpen',false);}setValue('');}
  return <div className="custom-add"><input aria-label="Add your own sector" value={value} maxLength={100} placeholder="e.g. Dental practices, HVAC, vertical SaaS" onChange={e=>setValue(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add();}}}/><button type="button" onClick={add} aria-label="Add custom sector">Add</button></div>;
}
export function CountryPicker(props:FieldsProps) {
  const {answers,change}=props;
  const [query,setQuery]=useState('');
  const q=query.toLowerCase().trim();
  const visible=COUNTRIES.filter(c=>(c.name+' '+c.code+(c.code==='GB'?' UK Britain':c.code==='US'?' USA':'' )).toLowerCase().includes(q));
  return <div className="field">
    <label id="countries-label">Countries in scope</label>
    <details className="country-picker"><summary aria-labelledby="countries-label">{answers.geographies.length?`${answers.geographies.length} selected`:'Choose countries'} <span aria-hidden="true">⌄</span></summary>
      <div className="country-menu"><input aria-label="Search countries" placeholder="Search countries…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();if(e.key==='Escape'){const d=e.currentTarget.closest('details')!;d.open=false;d.querySelector('summary')?.focus();}}}/>
      <div className="country-results">{visible.map(c=><button type="button" key={c.code} aria-pressed={answers.geographies.includes(c.name!)} onClick={()=>{change('geographies',answers.geographies.includes(c.name!)?answers.geographies.filter(v=>v!==c.name):[...answers.geographies,c.name!]);change('locationFlexible',false);}}>{c.name}<span aria-hidden="true">{answers.geographies.includes(c.name!)?'✓':''}</span></button>)}{!visible.length&&<p role="status">No countries found.</p>}</div></div>
    </details>
    <div className="chips country-selected">{answers.geographies.map(v=><button key={v} type="button" className="chip selected" aria-label={`Remove ${v}`} onClick={()=>change('geographies',answers.geographies.filter(c=>c!==v))}>{v} <span aria-hidden="true">×</span></button>)}</div>
  </div>;
}
export function Range({prefix,label,note,answers,change}:{prefix:'revenue'|'ebitda'|'dealSize';label:string;note:string}&FieldsProps) {
  return <div className="range-row"><div className="range-label"><strong>{label}</strong><span>{note}</span></div><div className="two-fields">{(['Min','Max'] as const).map(bound=>{const field=(prefix+bound) as MoneyField;return <div key={bound}><label htmlFor={field}>{bound==='Min'?'Minimum':'Maximum'}</label><input id={field} aria-label={`${bound==='Min'?'Minimum':'Maximum'} ${label} in millions`} type="number" min="0" max="1000000" step="any" placeholder="Open" value={answers[field]??''} onChange={e=>change(field,e.target.value===''?null:Number(e.target.value))}/></div>;})}</div></div>;
}
