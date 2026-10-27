import {posix} from 'node:path';
import {parseJsx} from './source-parser.mjs';
function children(node) {return Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(v=>v?.type) : value?.type ? [value] : []);}
function walk(node,visit) {if(!node?.type)return;visit(node);for(const child of children(node))walk(child,visit);}
function bindings(pattern) {
  if(pattern.type==='Identifier')return [pattern.name];
  if(pattern.type==='ArrayPattern')return pattern.elements.filter(Boolean).flatMap(bindings);
  if(pattern.type==='ObjectPattern')return pattern.properties.flatMap(p=>bindings(p.type==='RestElement'?p.argument:p.value));
  if(pattern.type==='AssignmentPattern')return bindings(pattern.left);
  if(pattern.type==='RestElement')return bindings(pattern.argument);
  throw new Error("Unknown binding pattern; screens were not split automatically.");
}
function importsFor(imports,source,path) {
  return imports.map(node=>{
    if(!node.source.value.startsWith('.'))return source.slice(node.start,node.end);
    const target=posix.normalize(posix.join('src',node.source.value));
    let relative=posix.relative(posix.dirname(path),target);if(!relative.startsWith('.'))relative='./'+relative;
    return source.slice(node.start,node.source.start)+JSON.stringify(relative)+source.slice(node.source.end,node.end);
  }).join('\n');
}
function unwrapRoute(node) {
  if(node.type!=='JSXFragment')return node;
  const significant=node.children.filter(n=>n.type!=='JSXText'||n.value.trim());
  return significant.length===1 && significant[0].type==='JSXExpressionContainer' ? significant[0].expression : node;
}
export const splitScreensRule=Object.freeze({
  id:'split-react-screens-v1',description:"Recognized screen returns moved to separate files; state and handlers moved to a hook.",
  applies:({files,plan})=>Boolean(plan.separateScreens && files.some(f=>f.path==='src/App.jsx') && !files.some(f=>f.path.startsWith('src/screens/'))),
  async transform({files,sources}) {
    const original=files.find(f=>f.path==='src/App.jsx'),source=original.content;
    const ast=await parseJsx(source),body=ast.program.body;
    const exports=body.filter(n=>n.type==='ExportDefaultDeclaration');
    const app=exports[0]?.declaration;
    if(exports.length!==1||app?.type!=='FunctionDeclaration'||app.params.length||app.async||app.generator||app.id?.name!=='App'||body.some(n=>n.type!=='ImportDeclaration'&&n!==exports[0]))throw new Error("Screen splitting only supports a standard App function without parameters or additional module code.");
    let unsafe=false;
    walk(app.body,n=>{if(n.type==='ThisExpression'||n.type==='Super'||n.type==='MetaProperty'||(n.type==='Identifier'&&['arguments','App'].includes(n.name)))unsafe=true;});
    if(unsafe)throw new Error("Screen splitting stopped at context-dependent App references.");
    const imports=body.filter(n=>n.type==='ImportDeclaration');
    const statements=app.body.body,final=statements.at(-1);
    if(final?.type!=='ReturnStatement'||!final.argument)throw new Error("No unambiguous final screen return.");
    const logic=[],guards=[];let routing=false;
    for(const statement of statements.slice(0,-1)) {
      const returned=statement.type==='IfStatement'&&!statement.alternate ? (statement.consequent.type==='ReturnStatement'?statement.consequent:statement.consequent.type==='BlockStatement'&&statement.consequent.body.length===1?statement.consequent.body[0]:null):null;
      if(returned?.type==='ReturnStatement'&&returned.argument){routing=true;guards.push({test:statement.test,argument:returned.argument});}
      else {if(routing||!['VariableDeclaration','ExpressionStatement','FunctionDeclaration','EmptyStatement'].includes(statement.type))throw new Error("Logic and screen returns are interleaved; no automatic split was performed.");logic.push(statement);}
    }
    const imported=imports.flatMap(n=>n.specifiers.map(spec=>spec.local.name));
    const names=logic.flatMap(n=>n.type==='VariableDeclaration'?n.declarations.flatMap(d=>bindings(d.id)):n.type==='FunctionDeclaration'?[n.id.name]:[]);
    if(new Set(names).size!==names.length||[...names,...imported].some(n=>/^StudioScreen\d+$|^useStudioApp$|^studioModel$/.test(n)))throw new Error("Name conflict in screen splitting.");
    const generated=[],hookPath='src/hooks/useStudioApp.jsx';
    const destructure=names.length?'const { '+names.join(', ')+' } = studioModel;':'';
    function screen(expression) {
      const index=generated.length+1,name='StudioScreen'+String(index).padStart(2,'0'),path='src/screens/'+name+'.jsx';
      if(index>20)throw new Error("Too many screens for automatic splitting.");
      const code=source.slice(expression.start,expression.end);
      generated.push({path,content:importsFor(imports,source,path)+'\n\nexport default function '+name+'({studioModel}) {\n  '+destructure+'\n  return (\n'+code+'\n  );\n}\n'});
      return '<'+name+' studioModel={studioModel}/>';
    }
    const guardCode=guards.map(g=>'  if ('+source.slice(g.test.start,g.test.end)+') return '+screen(g.argument)+';').join('\n');
    function route(node) {node=unwrapRoute(node);return node.type==='ConditionalExpression'?'(('+source.slice(node.test.start,node.test.end)+') ? '+screen(node.consequent)+' : '+route(node.alternate)+')':screen(node);}
    const finalRoute=route(final.argument);
    if(generated.length<2) return {files,details:"No multiple screen returns found; unchanged."};
    const hook={path:hookPath,content:importsFor(imports,source,hookPath)+'\n\nexport default function useStudioApp() {\n'+logic.map(n=>source.slice(n.start,n.end)).join('\n')+'\n  return { '+names.join(', ')+' };\n}\n'};
    const entry={path:'src/App.jsx',content:importsFor(imports,source,'src/App.jsx')+'\nimport useStudioApp from "./hooks/useStudioApp.jsx";\n'+generated.map(f=>'import '+f.path.split('/').at(-1).replace('.jsx','')+' from "./screens/'+f.path.split('/').at(-1)+'";').join('\n')+'\n\nexport default function App() {\n  const studioModel = useStudioApp();\n  '+destructure+'\n'+guardCode+'\n  return '+finalRoute+';\n}\n'};
    const occupied=new Set([...files.filter(f=>f!==original),...sources].map(f=>f.path));
    for(const file of [...generated,hook])if(occupied.has(file.path))throw new Error("A heuristic cannot overwrite an existing file: "+file.path);
    for(const file of [entry,hook,...generated])await parseJsx(file.content);
    return {files:[...files.filter(f=>f!==original),entry,hook,...generated],details:generated.length+" screen files and one shared hook; received logic and JSX preserved."};
  },
});
export const DEFAULT_FILE_HEURISTICS=Object.freeze([splitScreensRule]);
// Trusted, explicitly supplied rules only. No plugins or executable config from projects.
// A future header/footer rule uses this same interface and can be opt-in via applies().
export async function runFileHeuristics(files,context,{rules=DEFAULT_FILE_HEURISTICS}={}) {
  let current=structuredClone(files);const applied=[],ids=new Set();
  for(const rule of rules){
    if(!rule?.id||ids.has(rule.id)||typeof rule.applies!=='function'||typeof rule.transform!=='function')throw new Error("Invalid or duplicate heuristic.");ids.add(rule.id);
    const input={...structuredClone(context),files:structuredClone(current),sources:structuredClone(context.sources||[])};
    if(!await rule.applies(input))continue;
    const result=await rule.transform(input);
    if(!Array.isArray(result?.files))throw new Error("The heuristic produced no files: "+rule.id);
    if(JSON.stringify(current)!==JSON.stringify(result.files))applied.push({id:rule.id,description:rule.description,details:result.details||'',paths:result.files.map(f=>f.path)});
    current=structuredClone(result.files);
  }
  return {files:current,applied};
}
