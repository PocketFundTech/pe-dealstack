// Bounded suggestions from explicit wording, with no model or external research.
// Suggestions only fill untouched fields. Every value is reviewed in the flow.
import { emptyAnswers } from './schema.js';
const SECTORS = [
  [/\b(?:business|b2b) services\b/i,'Business services'],[/\b(?:software|saas)\b/i,'Software'],
  [/\bhealthcare|health care\b/i,'Healthcare'],[/\bindustrials?|manufacturing\b/i,'Industrials'],
  [/\bconsumer\b/i,'Consumer'],[/\bfinancial services\b/i,'Financial services'],
  [/\btech-enabled\b/i,'Tech-enabled services'],[/\benergy\b/i,'Energy'],
  [/\blogistics\b/i,'Logistics'],[/\beducation\b/i,'Education'],
];
const MARKETS = [
  [/\b(?:us|usa|united states|u\.s\.)\b/i,'United States'],[/\bcanada|canadian\b/i,'Canada'],
  [/\b(?:uk|united kingdom|britain|british)\b/i,'United Kingdom'],
  [/\bindia|indian\b/i,'India'],
  [/\baustralia\b/i,'Australia'],[/\bnew zealand\b/i,'New Zealand'],
];
export function parseBrief(thesis) {
  const a=emptyAnswers(), t=thesis.replace(/[–—]/g,'-');a.thesis=thesis;
  const positive=t.replace(/\b(?:no|not|excluding|exclude|avoid)\s+[^.;\n]+/gi,'');
  a.sectorsInclude=SECTORS.filter(([r])=>r.test(positive)).map(([,s])=>s);
  a.geographies=MARKETS.filter(([r])=>r.test(positive)).map(([,s])=>s);
  if(/self[- ]funded/i.test(t))a.buyerType='Self-funded searcher';
  else if(/independent sponsor/i.test(t))a.buyerType='Independent sponsor / Consolidator';
  else if(/search fund/i.test(t))a.buyerType='Traditional search fund';
  else if(/advis[eory]+|advise a buyer/i.test(t))a.buyerType='M&A Advisor';
  else if(/private equity|\bPE firm/i.test(t))a.buyerType='Private equity firm';
  if(/two[- ]person|team of [23]|2-3 people/i.test(t))a.teamSize='1–5';
  if(/recurring revenue/i.test(positive))a.features.push('Recurring revenue');
  if(/profitable/i.test(positive))a.features.push('Profitable');
  if(/low capex|low capital expenditure/i.test(positive))a.features.push('Low CapEx');
  if(/\bb2b\b/i.test(positive))a.features.push('B2B');
  if(/management stay|management.{0,15}in place/i.test(positive))a.features.push('Management team in place');
  if(/no turnarounds|avoid turnarounds|excluding turnarounds/i.test(t))a.hardExclusions.push('Turnarounds');
  if(/platform acquisition/i.test(positive))a.transactionTypes.push('Platform acquisition');
  if(/add-on acquisition/i.test(positive))a.transactionTypes.push('Add-on acquisition');
  if(/majority/i.test(positive))a.transactionTypes.push('Majority buyout');
  if(/broker inbound/i.test(positive))a.sources.push('Broker / adviser inbound');
  // Keep currency distinct from fund size, check size, and the target metrics.
  if(/£/.test(t))a.currency='GBP';else if(/€/.test(t))a.currency='EUR';else if(/₹/.test(t))a.currency='INR';
  const re=/([$£€₹]?)\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*([$£€₹]?)\s*(\d+(?:\.\d+)?)\s*(?:m|million)\s*(?:in\s+)?(ebitda|revenue|enterprise value|ev)\b/gi;
  for(const m of t.matchAll(re)) {
    const prefix=/ebitda/i.test(m[5])?'ebitda':/revenue/i.test(m[5])?'revenue':'dealSize';
    a[prefix+'Min']=Number(m[2]);a[prefix+'Max']=Number(m[4]);
  }
  return a;
}
