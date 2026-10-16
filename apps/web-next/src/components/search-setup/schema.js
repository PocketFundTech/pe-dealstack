import { COUNTRIES } from './countries.js';
export const STEPS = [
  ['brief', 'Your search'], ['team', 'Your team'], ['sectors', 'Sectors'],
  ['geography', 'Geography'], ['size', 'Deal size'], ['fit', 'What fits'],
  ['transaction', 'Transaction'], ['workflow', 'Deal flow'], ['review', 'Review'],
];
export const OPTIONS = {
  buyerType: ['Traditional search fund', 'Self-funded searcher', 'Independent sponsor / Consolidator', 'Private equity firm', 'M&A Advisor', 'Corporate acquirer'],
  teamSize: ['1–5', '6–10', '11–20', '20+'],
  sectorsInclude: ['Business services', 'Software', 'Healthcare', 'Industrials', 'Consumer', 'Financial services', 'Tech-enabled services', 'Energy', 'Logistics', 'Education'],
  geographies: COUNTRIES.map(country=>country.name),
  features: ['Recurring revenue', 'Profitable', 'Low CapEx', 'Diversified customers', 'Owner-operated', 'Management team in place', 'B2B', 'Asset-light', 'Strong cash conversion', 'Other'],
  hardExclusions: ['Turnarounds', 'Pre-revenue businesses', 'High customer concentration', 'Heavy CapEx', 'Project-only revenue', 'Venture-backed businesses', 'Highly regulated sectors'],
  transactionTypes: ['Platform acquisition', 'Add-on acquisition', 'Majority buyout', 'Minority investment', 'Open to structure'],
  timeline: ['Actively reviewing deals', 'Looking to close within 6 months', 'Looking to close in 6–12 months', 'Still shaping the search'],
  fundingStage: ['Capital committed', 'Investor-backed search', 'Self-funded search', 'Raising deal-by-deal'],
  ownerTransition: ['Flexible', 'A short handover', 'Owner stays involved', 'Management already in place'],
  sources: ['Broker / adviser inbound', 'Proprietary outreach', 'Referrals & network', 'Marketplaces', 'Existing pipeline'],
  dealVolume: ['Fewer than 10', '10–25', '26–50', 'More than 50', 'Not tracking yet'],
  firstFocus: ['Screen incoming deals', 'Organise outreach & follow-ups', 'Manage active due diligence', 'Bring everything into one pipeline'],
};
export const EXAMPLES = [
  {label:'Search fund', text:'We’re a two-person search fund looking to acquire a profitable B2B services company in the US or Canada, with $1–3M EBITDA. Recurring revenue and an owner who can support a transition would be ideal. No turnarounds.'},
  {label:'Independent sponsor', text:'We’re an independent sponsor looking for a platform acquisition in UK healthcare services. We target £5–20M revenue and £1–4M EBITDA, with management staying in place.'},
  {label:'Buy-side advisory', text:'We advise a buyer seeking an India-based industrials business with ₹20–100M revenue. We’re reviewing broker inbound and want a consistent first screen for each opportunity.'},
];
export const RANGE_FIELDS = ['revenueMin', 'revenueMax', 'ebitdaMin', 'ebitdaMax', 'dealSizeMin', 'dealSizeMax'];
export const ARRAY_FIELDS = ['sectorsInclude', 'geographies', 'features', 'hardExclusions', 'transactionTypes', 'sources'];
export const STRING_FIELDS = ['thesis', 'buyerType', 'firmName', 'website', 'teamSize', 'geographyNotes', 'currency', 'otherCriteria', 'extraExclusions', 'timeline', 'fundingStage', 'ownerTransition', 'dealVolume', 'firstFocus', 'searchName'];
export const BOOL_FIELDS = ['sectorOpen', 'locationFlexible', 'sizeFlexible'];
export function emptyAnswers() {
  return Object.fromEntries([...STRING_FIELDS.map(k=>[k,k==='currency'?'USD':'']), ...ARRAY_FIELDS.map(k=>[k,[]]), ...RANGE_FIELDS.map(k=>[k,null]), ...BOOL_FIELDS.map(k=>[k,false])]);
}
export function normalizeAnswers(input = {}) {
  const a=emptyAnswers();
  for(const key of STRING_FIELDS) if(typeof input[key]==='string') a[key]=input[key].trim().slice(0,key==='thesis'?5000:key==='otherCriteria'?240:1000);
  for(const key of ARRAY_FIELDS) if(Array.isArray(input[key]))a[key]=[...new Set(input[key].filter(v=>typeof v==='string').map(v=>v.trim().slice(0,100)).filter(Boolean))].slice(0,key==='geographies'?250:25);
  for(const key of RANGE_FIELDS) if(input[key]!==null&&input[key]!==undefined&&String(input[key]).trim()!=='')a[key]=Number(input[key]);
  for(const key of BOOL_FIELDS)a[key]=input[key]===true;
  const buyerAliases={'Search fund':'Traditional search fund','Independent sponsor':'Independent sponsor / Consolidator','M&A adviser':'M&A Advisor','Advisor':'M&A Advisor'};
  a.buyerType=buyerAliases[a.buyerType]||a.buyerType;
  const teamAliases={'Just me':'1–5','2–3 people':'1–5'};a.teamSize=teamAliases[a.teamSize]||a.teamSize;
  return a;
}
export function validWebsite(value){try{const u=new URL(/^[a-z]+:\/\//i.test(value)?value:'https://'+value);return ['http:','https:'].includes(u.protocol)&&u.hostname.includes('.')&&!u.username&&!u.password;}catch{return false;}}
export function validateStep(step,a) {
  if(step==='brief' && a.thesis.trim().length<20)return 'Tell us a little more about your search. At least 20 characters is enough to start.';
  if(step==='team' && !OPTIONS.buyerType.includes(a.buyerType))return 'Choose the option that best describes your team.';
  if(step==='team'&&!a.firmName.trim())return 'Enter your firm name.';
  if(step==='team'&&!validWebsite(a.website))return 'Enter a valid firm website, such as yourfirm.com.';
  if(step==='fit'&&a.features.includes('Other')&&!a.otherCriteria.trim())return 'Add a short sentence for your other criteria.';
  if(step==='sectors' && !a.sectorOpen&&!a.sectorsInclude.length)return 'Choose at least one sector, or keep your search sector-agnostic.';
  if(step==='geography'&&!a.locationFlexible&&!a.geographies.length)return 'Choose at least one country, or keep geography open.';
  if(step==='geography'&&!a.locationFlexible&&a.geographies.some(v=>!OPTIONS.geographies.includes(v)))return 'Choose countries from the list, or keep geography open.';
  if(step==='size') {
    if(!['USD','GBP','EUR','INR','CAD','AUD'].includes(a.currency))return 'Choose a currency.';
    for(const key of RANGE_FIELDS)if(a[key]!==null&&(!Number.isFinite(a[key])||a[key]<0||a[key]>1000000))return 'Use a positive amount in millions, up to 1,000,000.';
    for(const [min,max,label] of [['revenueMin','revenueMax','Revenue'],['ebitdaMin','ebitdaMax','EBITDA'],['dealSizeMin','dealSizeMax','Enterprise value']])if(a[min]!==null&&a[max]!==null&&a[min]>a[max])return `${label}: the minimum must be lower than the maximum.`;
    if(!a.sizeFlexible&&RANGE_FIELDS.every(k=>a[k]===null))return 'Add a financial range, or choose “Still flexible on size”.';
  }
  if(step==='transaction'&&!a.transactionTypes.length)return 'Choose a transaction type, or select “Open to structure”.';
  if(step==='transaction'&&!OPTIONS.timeline.includes(a.timeline))return 'Choose where your search is today.';
  if(step==='transaction'&&!OPTIONS.fundingStage.includes(a.fundingStage))return 'Choose your capital readiness.';
  if(step==='workflow'&&!OPTIONS.firstFocus.includes(a.firstFocus))return 'Choose where Avise can help first.';
  if(step==='review'&&a.searchName.trim().length<2)return 'Give this search a name of at least two characters.';
  return '';
}
export function validateAll(a) {for(const [step] of STEPS){const error=validateStep(step,a);if(error)return {step,error};}return null;}
export function currencySymbol(currency){return {USD:'$',GBP:'£',EUR:'€',INR:'₹',CAD:'C$',AUD:'A$'}[currency]||currency;}
export function rangeLabel(min,max,currency) {
  const symbol=currencySymbol(currency);
  if(min===null&&max===null)return 'Open';
  if(min===null)return `Up to ${symbol}${max}M`;
  if(max===null)return `${symbol}${min}M+`;
  return `${symbol}${min}–${max}M`;
}
export function criteriaPayload(a) {
  return {sectorsInclude:a.sectorOpen?[]:a.sectorsInclude,sectorsExclude:[],dealSizeMin:a.dealSizeMin,dealSizeMax:a.dealSizeMax,revenueMin:a.revenueMin,revenueMax:a.revenueMax,ebitdaMin:a.ebitdaMin,hardExclusions:[...a.hardExclusions,...a.extraExclusions.split(/\n|;/).map(s=>s.trim()).filter(Boolean)],thesis:a.thesis};
}
export function suggestedName(a){return `${a.sectorOpen?'Sector-agnostic':a.sectorsInclude[0]||'Acquisition'} · ${a.locationFlexible?'Global':a.geographies[0]||'New search'}`;}
export function briefText(a) {
  return `# ${a.searchName}\n\n## Search thesis\n${a.thesis}\n\n## Team\n${a.firmName||'Not specified'} · ${a.buyerType} · ${a.teamSize||'Team size not specified'}\n${a.website||''}\n\n## Target sectors\n${a.sectorOpen?'Sector-agnostic':a.sectorsInclude.join(', ')}\n\n## Geography\n${a.locationFlexible?'Open to all markets':a.geographies.join(', ')}\n${a.geographyNotes}\n\n## Financial criteria\nCurrency: ${a.currency}. All values in millions.\nRevenue: ${rangeLabel(a.revenueMin,a.revenueMax,a.currency)}\nEBITDA: ${rangeLabel(a.ebitdaMin,a.ebitdaMax,a.currency)}\nEnterprise value: ${rangeLabel(a.dealSizeMin,a.dealSizeMax,a.currency)}\n\n## Preferences\n${[...a.features.filter(v=>v!=='Other'),a.otherCriteria].filter(Boolean).join(', ')||'No additional preferences'}\n\n## Hard exclusions\n${[...a.hardExclusions,a.extraExclusions].filter(Boolean).join('\n')||'None specified'}\n\n## Transaction\n${a.transactionTypes.join(', ')}\nTiming: ${a.timeline||'Not specified'}\nCapital: ${a.fundingStage||'Not specified'}\nOwner transition: ${a.ownerTransition||'Flexible'}\n\n## Deal flow\n${a.sources.join(', ')||'Not specified'}\nMonthly volume: ${a.dealVolume||'Not specified'}\nFirst priority: ${a.firstFocus}\n`;
}
