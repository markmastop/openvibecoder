import {parseJsx} from '../parsing/source-parser.mjs';
export const PORTAL_CONFIG='src/app-config.json';
export function isPortalProject(sources){return sources.some(f=>f.path==='src/App.jsx'&&f.content.includes('// BIM-APP-SHELL v1'))||sources.some(f=>f.path===PORTAL_CONFIG&&f.content.includes('bim-portal-v1'));}
export function validatePortalConfig(config,paths) {
 const text=(v,max)=>typeof v==='string'&&v.length<=max;
 if(!config||config.template!=='bim-portal-v1'||!text(config.appName,80)||!config.appName.trim()||!text(config.tagline||'',160)||!text(config.logoText||'',8)||!text(config.logoUrl||'',500)||(config.logoUrl&&!/^https:\/\//.test(config.logoUrl)))throw new Error("Invalid app name, logo, or portal configuration.");
 if(!['none','supabase'].includes(config.authentication))throw new Error("Choose authentication none or supabase.");
 if(!config.theme||!['primary','accent'].every(key=>/^#[0-9a-fA-F]{6}$/.test(config.theme[key])))throw new Error("Use six-digit hex colors for primary and accent.");
 if(!config.footer||typeof config.footer.visible!=='boolean'||!text(config.footer.text,200))throw new Error("Invalid footer configuration.");
 if(!Array.isArray(config.routes)||!config.routes.length||config.routes.length>20)throw new Error('Registreer 1–20 schermen.');
 const used=new Set(),screens=new Set();
 for(const route of config.routes){if(!route||!/^\/[a-z0-9][a-z0-9/-]{0,79}$/.test(route.path)||route.path.includes('//')||!text(route.title,50)||!route.title.trim()||!/^\w[\w-]{0,79}$/.test(route.screen)||used.has(route.path)||screens.has(route.screen)||!paths.has('src/screens/'+route.screen+'.jsx'))throw new Error("Invalid, duplicate, or missing screen registration.");used.add(route.path);screens.add(route.screen);}
 return config;
}
export const PORTAL_CONTRACT=`BIM-PORTAL v1. Open Vibe Coder manages App.jsx and src/studio/ui/ (layout, header, footer, menu, hash navigation, mobile controls, and optional Supabase sign-in). Do not modify these files or return App.jsx. Build screens as default-export React components under src/screens/NameScreen.jsx. Do not add your own header, footer, menu, or min-h-screen wrapper: use Page from the correct relative path to studio/ui/components.jsx. Available components: Page({title,description,actions}), Button({pending,variant:'primary'|'secondary'|'danger',type}), Field({label,error,hint,...inputProps}), Notice({tone:'info'|'success'|'error'}), LoadingState, EmptyState, ErrorState({message,onRetry}), ConfirmDialog({open,title,onConfirm,onCancel,pending}), formatMoney(cents), and formatDate(ISO). usePortal from studio/ui/AppShell.jsx provides {config,navigate,currentRoute,user}. App name, logo, colors, footer, authentication ('none' or 'supabase'), and routes are in src/app-config.json. Shared styles: Button variant primary uses theme.accent as its background; AppShell calculates a contrasting text color automatically. theme.primary controls headings, logo, and secondary button text. theme.accent also controls links, focus, and active navigation accents. Configure these values through src/app-config.json; use src/styles.css for custom additional styles. Preserve the meaning of secondary and danger. A route is {path:'/employees',title:'Employees',screen:'EmployeesScreen',icon:'users'}. Return configuration only when changing it. New screens without routes are registered locally. Existing screens are preserved. Connection clients are under src/studio/.`;
export async function preparePortalFiles(files,sources) {
 const entry=sources.find(f=>f.path==='src/App.jsx');
 const supplied=files.find(f=>f.path==='src/App.jsx');
 if(supplied&&supplied.content!==entry?.content)throw new Error("Open Vibe Coder manages the portal entry App.jsx. Return only screens, components, or app-config.json.");
 const merged=new Map(sources.map(f=>[f.path,f.content]));for(const f of files)merged.set(f.path,f.content);
 let config;try{config=JSON.parse(merged.get(PORTAL_CONFIG));}catch{throw new Error("app-config.json is not valid JSON.");}
 if(!Array.isArray(config.routes))throw new Error("Screen registration is missing.");
 const additions=[];
 for(const file of files){
  const match=file.path.match(/^src\/screens\/([\w-]+)\.jsx$/);if(!match)continue;
  const ast=await parseJsx(file.content);if(!ast.program.body.some(n=>n.type==='ExportDefaultDeclaration'))throw new Error("Each screen requires a default export: "+file.path);
  if(config.routes.some(r=>r.screen===match[1]))continue;
  // Derive only a menu label/route from the actual filename, never business logic.
  const title=match[1].replace(/Screen$/,'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[-_]/g,' ').trim()||"Screen";
  const path='/'+title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if(config.routes.some(r=>r.path===path))throw new Error("This menu path already exists. Give the new screen a unique route.");
  config.routes.push({path,title,screen:match[1],icon:'page'});additions.push(file.path);
 }
 validatePortalConfig(config,new Set(merged.keys()));
 let result=files.filter(f=>f.path!=='src/App.jsx');
 if(additions.length){result=result.filter(f=>f.path!==PORTAL_CONFIG);result.push({path:PORTAL_CONFIG,content:JSON.stringify(config,null,2)+'\n'});}
 return {files:result,heuristics:additions.length?[{id:'portal-route-registry-v1',description:"Register new screens in the shared navigation.",details:additions.length+" new screen added to navigation; no additional AI request.",paths:additions}]:[]};
}
