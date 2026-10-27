import {isPortalProject,PORTAL_CONTRACT,PORTAL_CONFIG} from './portal-project.mjs';
import { posix } from 'node:path';
import { projectPath } from './project-files.mjs';
const words = text => [...new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || []).filter(w => !['deze','voor','toon','maak','geef','alleen','huidige','behoud','gebruik','niet','wordt','scherm','bestand','bestanden','this','show','make','give','only','current','keep','preserve','using','with','that','from','into','screen','file','files','src','jsx','code'].includes(w)))];
export function projectContext(sources, { prompt, plan, feedback = '', schema = null, preferredPaths = [] }) {
  const portal=isPortalProject(sources);
  const editable = sources.filter(f => { try { projectPath(f.path); return !(portal&&f.path==='src/App.jsx'); } catch { return false; } });
  const terms = words(prompt);
  const money = /bedrag|amount|euro|dollar|valuta|currency|kosten|cost|price|money|kilomet|km\b/i.test(prompt);
  const aliases = money ? ['amount','currency','kilometres','reiskosten'] : [];
  if (/euro|dollar|valuta|currency/i.test(prompt)) aliases.push('$','€');
  const score = f => (preferredPaths.includes(f.path) ? 2000-preferredPaths.indexOf(f.path) : 0) + (prompt.includes(f.path) ? 1000 : 0) + (f.path === 'src/App.jsx' ? 10 : f.path===PORTAL_CONFIG?900:0) + terms.reduce((n,w) => n + (f.path.toLowerCase().includes(w) ? 20 : 0) + (f.content.toLowerCase().includes(w) ? 1 : 0), 0);
  const ranked = editable.filter(f => f.path !== 'README.md' || preferredPaths.includes(f.path)).sort((a,b) => score(b)-score(a));
  const records = []; let used = 0;
  const limit = plan.contextLimit;
  const selected=ranked.slice(0,plan.size==='small'?Math.max(4,preferredPaths.length):16);
  // One import hop: include the chosen screen's local helpers, never managed clients.
  const dependencies=[];
  for(const file of selected) for(const match of file.content.matchAll(/(?:from\s*|import\s*\(?)['"](\.[^'"]+)['"]/g)) {
    const base=posix.normalize(posix.join(posix.dirname(file.path),match[1]));
    const dependency=editable.find(f=>[base,base+'.jsx',base+'.js',base+'/index.jsx',base+'/index.js'].includes(f.path));
    if(dependency && !selected.includes(dependency) && !dependencies.includes(dependency)) dependencies.push(dependency);
  }
  for (const f of [...selected,...dependencies].slice(0,plan.size==='small'?Math.max(6,preferredPaths.length):20)) {
    const lines = f.content.split('\n');
    let ranges = [[1, lines.length]];
    if (plan.size === 'small' && f.content.length > 5500 && !preferredPaths.includes(f.path)) {
      const wanted = new Set();
      const include = (start,end) => { for (let i=Math.max(0,start);i<Math.min(lines.length,end);i++) wanted.add(i); };
      include(0,20);
      const location = (prompt+'\n'+feedback).match(/(?:(?:regel|line)\s+|:(\d+):)(\d+)?/i);
      const line = location ? Number(location[1] || location[2]) : 0;
      if (line && (prompt.includes(f.path) || feedback.includes(f.path))) include(line-26,line+20);
      let windows = 0;
      const candidates=lines.map((text,i)=>({i,score:terms.reduce((n,w)=>n+(text.toLowerCase().includes(w)?3:0),0)+aliases.reduce((n,w)=>n+(text.toLowerCase().includes(w)?(w==='$'||w==='€'?12:1):0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.i-b.i);
      for (const {i} of candidates) if(windows<6 && !wanted.has(i)) {include(i-10,i+18);windows++;}
      ranges=[];
      for (const i of [...wanted].sort((a,b)=>a-b)) {const last=ranges.at(-1); if(last && last[1]===i)last[1]=i+1;else ranges.push([i+1,i+1]);}
    }
    for (const [from,to] of ranges) {
      const content=lines.slice(from-1,to).join('\n');
      if (used+content.length>limit) continue;
      records.push({path:f.path,from,to,complete:from===1 && to===lines.length,content}); used+=content.length;
    }
  }
  if (preferredPaths.some(path=>!records.some(r=>r.path===path))) throw new Error("The build plan requires more source context than fits. Choose a larger change; no build model was called.");
  if (!portal && !records.some(f=>f.path==='src/App.jsx') && !prompt.match(/src\//)) throw new Error("No usable app context found. Choose a large change or name the correct file.");
  const contract=sources.find(f=>f.path==='README.md')?.content || '';
  // Include the app's API contract, not the entire build history or README.
  const start=contract.search(/HR-APP-CONTRACT|API.CONTRACT|Datamodel|Data model|RPC/i);
  const relevantContract= start>=0 ? contract.slice(start,start+6500) : contract.slice(0,1200);
  let schemaText = '';
  if (/supabase|database|tabel|table|opslaan|save|storage|declaratie|expense|medewerker|employee|inlog|login|sign.?in|profiel|profile|rpc|klant|customer/i.test(prompt)) {
    const text=JSON.stringify(schema);
    if(text.length<=8000) schemaText=text;
    else schemaText="The data model is too large for this context. Ask for the relevant table or RPC contract; do not invent names.";
  }
  return { portal, records, contract:(portal?PORTAL_CONTRACT+'\n':'')+relevantContract, schema:schemaText, feedback:String(feedback).slice(0,1800), manifest:editable.map(f=>f.path), omitted:editable.filter(f=>!records.some(r=>r.path===f.path)).map(f=>f.path), sourceCharacters:used, totalSourceCharacters:sources.reduce((n,f)=>n+f.content.length,0) };
}
