import { OPTIONS, EXAMPLES, rangeLabel } from './schema.js';
import { Group, TextInput, Toggle, Choices, SelectField, SectorInput, CountryPicker, Range, type FieldsProps } from './fields';
import type { Step, Field } from './types';
export const TITLES:Record<Step,string>={brief:'Tell us about your search.',team:'Who’s behind the search?',sectors:'What kinds of businesses fit?',geography:'Where are you looking?',size:'What size is the right fit?',fit:'What makes a good fit?',transaction:'What kind of deal works?',workflow:'How does deal flow reach you?',review:'Your search, at a glance.'};
const INTRO:Record<Step,string>={brief:'What kind of business would you like to buy?',team:'A little about you.',sectors:'Pick the industries you’re interested in.',geography:'Where should the business be based?',size:'A rough range is fine. Leave anything open.',fit:'What’s a yes, and what’s a no?',transaction:'How would you like to buy?',workflow:'Let’s make this fit the way you work.',review:'Look good? You can change any of this later.'};
export function StepContent({step,touched,edit,...props}:{step:Step;touched:Field[];edit:(step:Step)=>void}&FieldsProps) {
  const {answers:a,change}=props;
  const known:Partial<Record<Step,Field>>={team:'buyerType',sectors:'sectorsInclude',geography:'geographies',transaction:'transactionTypes'};
  const field=known[step], value=field?a[field]:null;
  const inferred=field&&!touched.includes(field)&&(Array.isArray(value)?value.length:!!value);
  return <>
    <h1 id="step-title" tabIndex={-1}>{TITLES[step]}</h1><p className="step-intro">{INTRO[step]}</p>
    {inferred?<p className="carried-forward">✓ From your description. Change anything below.</p>:null}
    {step==='brief'&&<>
      <p className="setup-explanation">These 9 steps build your firm profile and search context, so Dealstack can tailor deal screening and AI responses to your needs. You can skip setup and add this later.</p>
      <label className="sr-only" htmlFor="thesis">Tell us about your search</label><div className="brief-input"><textarea id="thesis" rows={5} maxLength={5000} value={a.thesis} onChange={e=>change('thesis',e.target.value)} placeholder="I’m looking for a B2B services business in the US, with $1–3M EBITDA. Ideally recurring revenue and an owner ready to retire…"/></div>
      <div className="example-area"><span>Still figuring it out? That’s fine.</span><button type="button" onClick={()=>change('thesis',EXAMPLES[0].text)}>Try an example</button></div>
    </>}
    {step==='team'&&<>
      <Group title="Which best describes your team?"><Choices {...props} field="buyerType" single cards/></Group>
      <div className="two-fields"><TextInput {...props} field="firmName" label="Firm / team name" placeholder="Your firm" max={200}/><TextInput {...props} field="website" label="Firm website" placeholder="yourfirm.com"/></div>
      <Group title="How many people work on deals?"><Choices {...props} field="teamSize" single/></Group>
    </>}
    {step==='sectors'&&<>
      <Toggle {...props} field="sectorOpen" label="We’re sector-agnostic" note="Keep the search open to different industries."/>
      <Group title="Sectors in scope"><Choices {...props} field="sectorsInclude" options={[...OPTIONS.sectorsInclude,...a.sectorsInclude.filter(v=>!OPTIONS.sectorsInclude.includes(v))]}/><SectorInput {...props}/></Group>
    </>}
    {step==='geography'&&<>
      <Toggle {...props} field="locationFlexible" label="Keep geography open" note="We’ll assess each opportunity on its merits."/><CountryPicker {...props}/>
      <div className="field"><label htmlFor="geographyNotes">Anything more specific?<span>Optional</span></label><textarea id="geographyNotes" rows={2} maxLength={1000} value={a.geographyNotes} onChange={e=>change('geographyNotes',e.target.value)} placeholder="e.g. HQ in the UK, or within two hours of London"/></div>
    </>}
    {step==='size'&&<>
      <div className="currency-row"><span className="field-kicker">ALL VALUES IN MILLIONS</span><label htmlFor="currency">Currency <select id="currency" value={a.currency} onChange={e=>change('currency',e.target.value)}>{['USD','GBP','EUR','INR','CAD','AUD'].map(v=><option key={v}>{v}</option>)}</select></label></div>
      <Range {...props} prefix="revenue" label="Revenue" note="Annual sales"/><Range {...props} prefix="ebitda" label="EBITDA" note="Annual operating earnings"/><Range {...props} prefix="dealSize" label="Enterprise value" note="Total business value, not your equity cheque"/>
      <Toggle {...props} field="sizeFlexible" label="Still flexible on size" note="We can refine these ranges as the search develops."/>
    </>}
    {step==='fit'&&<>
      <Group title="What would you like to see?" note="Preferences, not automatic exclusions"><Choices {...props} field="features"/>{a.features.includes('Other')&&<TextInput {...props} field="otherCriteria" label="Other criteria" max={240} placeholder="e.g. Prefer long-term customer contracts"/>}</Group>
      <Group title="What’s out of scope?" note="Hard exclusions"><Choices {...props} field="hardExclusions"/></Group>
    </>}
    {step==='transaction'&&<>
      <Group title="Which structures are in scope?" note="Select all that apply"><Choices {...props} field="transactionTypes"/></Group>
      <div className="two-fields"><SelectField {...props} field="timeline" label="Where is the search today?" placeholder="Select a stage"/><SelectField {...props} field="fundingStage" label="Capital readiness" placeholder="Select an option"/></div>
      <Group title="What would a good owner transition look like?" note="Optional"><Choices {...props} field="ownerTransition" single/></Group>
    </>}
    {step==='workflow'&&<>
      <Group title="Where do opportunities come from?" note="Select all that apply"><Choices {...props} field="sources"/></Group>
      <details className="optional-details"><summary>Monthly deal volume <span>Optional</span></summary><Group title="How many teasers or CIMs a month?"><Choices {...props} field="dealVolume" single/></Group></details>
      <Group title="Where should Avise help first?"><Choices {...props} field="firstFocus" single cards/></Group>
    </>}
    {step==='review'&&<>
      <TextInput {...props} field="searchName" label="Give this search a name" max={200}/>
      <div className="review-thesis"><span className="field-kicker">YOUR SEARCH THESIS</span><p>{a.thesis}</p><button type="button" onClick={()=>edit('brief')}>Edit description →</button></div>
      <dl className="review-table">{([
        ['team','Team',[a.firmName,a.website,a.buyerType,a.teamSize].filter(Boolean).join(' · ')],
        ['sectors','Sectors',a.sectorOpen?'Sector-agnostic':a.sectorsInclude.join(', ')],
        ['geography','Geography',(a.locationFlexible?'Open to all markets':a.geographies.join(', '))+(a.geographyNotes?` · ${a.geographyNotes}`:'')],
        ['size','Financial criteria',`Currency: ${a.currency} · Revenue: ${rangeLabel(a.revenueMin,a.revenueMax,a.currency)} · EBITDA: ${rangeLabel(a.ebitdaMin,a.ebitdaMax,a.currency)} · Enterprise value: ${rangeLabel(a.dealSizeMin,a.dealSizeMax,a.currency)}`],
        ['fit','Preferences & exclusions',`Prefer: ${[...a.features.filter(v=>v!=='Other'),a.otherCriteria].filter(Boolean).join(', ')||'None specified'}. Exclude: ${[...a.hardExclusions,a.extraExclusions].filter(Boolean).join(', ')||'None specified'}.`],
        ['transaction','Transaction',[a.transactionTypes.join(', '),a.timeline,a.fundingStage,a.ownerTransition].filter(Boolean).join(' · ')],
        ['workflow','Deal flow',[a.sources.join(', '),a.dealVolume,a.firstFocus].filter(Boolean).join(' · ')],
      ] as [Step,string,string][]).map(([s,label,text])=><div key={s}><dt>{label}</dt><dd>{text}</dd><button type="button" onClick={()=>edit(s)} aria-label={`Edit ${label.toLowerCase()}`}>Edit</button></div>)}</dl>
      <p className="soft-note">Saving fills missing firm settings and updates your search context. You can refine the profile in Settings later.</p>
    </>}
  </>;
}
