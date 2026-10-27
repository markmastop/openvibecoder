import React,{useId,useEffect,useRef} from 'react';
export function Button({children,pending=false,variant='primary',type='button',disabled,...props}) {
  return <button {...props} type={type} disabled={disabled||pending} aria-busy={pending||undefined} className={`bim-button bim-button-${variant} ${props.className||''}`}>{pending?"Please wait…":children}</button>;
}
export function Page({title,description,actions,children}) {return <section className="bim-page"><div className="bim-page-heading"><div><h1>{title}</h1>{description&&<p>{description}</p>}</div>{actions&&<div className="bim-page-actions">{actions}</div>}</div>{children}</section>;}
export function Notice({children,tone='info',title}) {return <div className={`bim-notice bim-notice-${tone}`} role={tone==='error'?'alert':'status'}>{title&&<strong>{title}</strong>}<div>{children}</div></div>;}
export function LoadingState({label="Loading data…"}) {return <div className="bim-loading" role="status"><span className="bim-spinner" aria-hidden="true"/>{label}</div>;}
export function EmptyState({title="No data yet",children,action}) {return <div className="bim-empty"><h2>{title}</h2>{children&&<p>{children}</p>}{action}</div>;}
export function ErrorState({message="Something went wrong.",onRetry}) {return <Notice tone="error" title="That did not work yet"><p>{message}</p>{onRetry&&<Button onClick={onRetry} variant="secondary">Try again</Button>}</Notice>;}
export function Field({label,error,hint,id,children,...props}) {
 const generated=useId(),inputId=id||generated,description=error||hint;
 return <div className="bim-field"><label htmlFor={inputId}>{label}</label>{children?React.cloneElement(children,{id:inputId,'aria-invalid':Boolean(error),'aria-describedby':description?inputId+'-hint':undefined}):<input {...props} id={inputId} aria-invalid={Boolean(error)} aria-describedby={description?inputId+'-hint':undefined}/>}{description&&<p id={inputId+'-hint'} className={error?'bim-field-error':''}>{description}</p>}</div>;
}
export function ConfirmDialog({open,title="Are you sure?",children,onConfirm,onCancel,pending=false}) {
 const ref=useRef(null),titleId=useId();
 useEffect(()=>{const dialog=ref.current;if(open&&!dialog.open)dialog.showModal();else if(!open&&dialog.open)dialog.close();},[open]);
 return <dialog ref={ref} className="bim-dialog" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();if(!pending)onCancel?.();}}><h2 id={titleId}>{title}</h2><div>{children}</div><div className="bim-dialog-actions"><Button variant="secondary" onClick={onCancel} disabled={pending}>Cancel</Button><Button onClick={onConfirm} pending={pending}>Confirm</Button></div></dialog>;
}
export function formatMoney(cents,currency='EUR'){return new Intl.NumberFormat('en-GB',{style:'currency',currency}).format(Number(cents)/100);}
export function formatDate(value){if(!value)return '—';const date=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T12:00:00':value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('en-GB').format(date);}
export function Icon({name='page',...props}) {
 const paths={home:'m3 10 9-7 9 7v11h-6v-7H9v7H3Z',users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',page:'M14 2H4v20h16V8Zm0 0v6h6M8 12h8M8 16h8',menu:'M4 6h16M4 12h16M4 18h16',close:'m6 6 12 12M6 18 18 6',chevron:'m9 5 7 7-7 7',logout:'M9 3H4v18h5m5-14 5 5-5 5m-5-5h10'};
 return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]||paths.page}/></svg>;
}
