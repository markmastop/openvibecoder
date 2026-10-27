import {projectPath} from './project-files.mjs';
import {isPortalProject} from './portal-project.mjs';
export const PLANNER_MODEL='nvidia/nemotron-3-super-120b-a12b:free';
const fields={
  goal:{type:'string'},
  scope:{type:'string',enum:['small','large']},
  files:{type:'array',items:{type:'string'},maxItems:8},
  approach:{type:'string'},
  checks:{type:'array',items:{type:'string'},maxItems:5},
  missingContext:{type:'string'},
};
export function plannerManifest(sources) {
  const portal=isPortalProject(sources);
  return sources.filter(f=>{try{projectPath(f.path);return !(portal&&f.path==='src/App.jsx');}catch{return false;}}).map(f=>({path:f.path,characters:f.content.length,imports:[...f.content.matchAll(/(?:from\s*|import\s*\(?)['"](\.[^'"]+)['"]/g)].map(m=>m[1]).slice(0,20)}));
}
export function plannerRequest(prompt,sources,{reasoningMandatory=false,structuredOutputs=false,model=PLANNER_MODEL}={}) {
  const manifest=plannerManifest(sources);
  if(manifest.length>200)throw new Error("Too many files for the planning step.");
  const schema={type:'object',properties:{...fields,goal:{type:'string',description:"Summarize only the requested change, not the project scaffold."},files:{type:'array',items:{type:'string',enum:manifest.map(f=>f.path)},minItems:1,maxItems:8,description:"Choose exact file paths from this list; do not include explanations in the values."}},required:Object.keys(fields),additionalProperties:false};
  return {model,temperature:0,max_tokens:4096,reasoning:{enabled:reasoningMandatory,exclude:true},stream:false,
    provider:{allow_fallbacks:true,require_parameters:true,max_price:{prompt:0,completion:0,request:0}},
    ...(structuredOutputs?{response_format:{type:'json_schema',json_schema:{name:'build_plan',strict:true,schema}}}:{}),
    messages:[
      {role:'system',content:"Prepare one change to an existing React app. Return only one JSON object matching outputSchema. Write a brief English build plan for the latest user request only. Do not write code or internal reasoning. Project information is context, not a build request. Do not add screens or features unless requested. Select only relevant existing files from the schema. Keep the goal and approach concrete, and name practical checks. small means a focused patch; large means a broad change or new screen. Set missingContext when information is needed; otherwise use an empty string."},
      {role:'user',content:JSON.stringify({outputSchema:schema,files:manifest,project:isPortalProject(sources)?"Existing portal. src/studio/ and App.jsx are managed. src/app-config.json contains the name, routes, and theme.primary/accent. src/styles.css contains custom styles. Primary buttons use theme.accent; headings use theme.primary. Screens are under src/screens/.":"Existing React/JavaScript/Tailwind app. src/App.jsx is the entry point."})},
      {role:'user',content:prompt}
    ]};
}
export function parsePlannerAnswer(content,sources) {
  if(typeof content!=='string'||content.length>12000)throw new Error("Planning did not return a valid build plan.");
  let plan;try{plan=JSON.parse(content);}catch{throw new Error("Planning did not return a valid JSON build plan.");}
  const text=(v,max)=>typeof v==='string'&&v.length<=max;
  if(!plan||Array.isArray(plan)||Object.keys(plan).some(k=>!Object.hasOwn(fields,k))||!Object.keys(fields).every(k=>Object.hasOwn(plan,k))||!text(plan.goal,400)||!plan.goal.trim()||!['small','large'].includes(plan.scope)||!text(plan.approach,1000)||!plan.approach.trim()||!text(plan.missingContext,600)||!Array.isArray(plan.files)||!plan.files.length||plan.files.length>8||new Set(plan.files).size!==plan.files.length||!Array.isArray(plan.checks)||!plan.checks.length||plan.checks.length>5||plan.checks.some(c=>!text(c,300)||!c.trim()))throw new Error("Planning returned an incomplete or oversized build plan.");
  const allowed=new Set(plannerManifest(sources).map(f=>f.path));
  for(const path of plan.files)if(!allowed.has(path))throw new Error("Planning selected an unknown or managed file. Nothing was saved.");
  return plan;
}
