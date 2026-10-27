import { readFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../config/redact.mjs';

export async function exportProjectHistory(project, reports, summary, secrets = []) {
  const lines = ["# Build history", '', "Maintained by Open Vibe Coder. Contains requests, model responses, and build results. Review the contents before sharing your project.", ''];
  for (const item of summary.history || []) {
    const round = (summary.rounds || []).find(r => r.startedAt === item.at);
    let model = item.model || round?.model;
    if (!model) { try { model=JSON.parse(await readFile(join(reports, `request-${item.modelCall}.json`),'utf8')).model; } catch {} }
    const result=item.step==='planning'?round?.planning:round;
    lines.push(`## Request ${item.modelCall} · ${item.at}`, '', `Model: ${model || summary.model || "unknown"}`, '', '### Prompt', '', item.prompt, '', "### Result", '', result?.error || result?.status || "Started", '');
    if(item.step==='planning') lines.push("Step: Planning · understanding the request (additional AI request).", '');
    for (const rule of round?.heuristics || []) lines.push("Local heuristic (no additional AI): "+rule.id+' · '+(rule.details || rule.description || ''), '');
    if(item.format) lines.push(`Build format: ${item.format === 'edits' ? "targeted patches" : "complete files"}; ${item.sourceCharacters} source characters included.`, '');
    try { lines.push("### Model response", '', await readFile(join(reports, `response-${item.modelCall}.md`), 'utf8').catch(error => { if (error.code === 'ENOENT') return readFile(join(reports, `antwoord-${item.modelCall}.md`), 'utf8'); throw error; }), ''); }
    catch (error) { if (error.code !== 'ENOENT') throw error; lines.push("No model response saved yet.", ''); }
  }
  if (!summary.history?.length) lines.push("No AI requests made yet.", '');
  const path = join(project, 'PROMPTS.md');
  try { if (!(await lstat(path)).isFile()) throw new Error("PROMPTS.md must be a regular file."); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(redact(lines.join('\n'), secrets)); } finally { await file.close(); }
}
