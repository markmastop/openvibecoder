import {isPortalProject,preparePortalFiles} from '../projects/portal-project.mjs';
import {parseProject,parseEdits,validateScreenStructure} from '../projects/project-files.mjs';
import {runFileHeuristics} from './project-heuristics.mjs';
export async function prepareProjectAnswer(content,{plan,sources=[]},options) {
  const portal=isPortalProject(sources);
  const parsed=plan.format==='edits'?parseEdits(content,sources):parseProject(content,{requireApp:!portal});
  if(portal){
    const result=await preparePortalFiles(parsed,sources);
    const checked=parseProject(JSON.stringify({files:result.files}),{requireApp:false});
    return {files:checked,heuristics:result.heuristics};
  }
  // Small exact patches never trigger an unsolicited architecture rewrite.
  const prepared=plan.format==='edits'?{files:parsed,applied:[]}:await runFileHeuristics(parsed,{plan,sources},options);
  const files=plan.format==='edits'?prepared.files:parseProject(JSON.stringify({files:prepared.files}));
  validateScreenStructure(files,plan);
  return {files,heuristics:prepared.applied};
}
