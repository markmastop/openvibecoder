import React,{createContext,useContext,useState,useEffect,useRef} from 'react';
import {Button,Icon,Page,ErrorState} from './components.jsx';
import {useOptionalSession,LoginScreen} from './session.jsx';
import './portal.css';
const PortalContext=createContext(null);
export function usePortal(){const value=useContext(PortalContext);if(!value)throw new Error("usePortal requires AppShell.");return value;}
class ScreenBoundary extends React.Component {
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<Page title="This screen could not be opened"><ErrorState message="Something went wrong on this screen." onRetry={()=>this.setState({failed:false})}/><Button variant="secondary" onClick={this.props.onHome}>Back to home</Button></Page>:this.props.children;}
}
function contrastInk(hex){const values=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return values[0]*.2126+values[1]*.7152+values[2]*.0722>.179?'#111827':'#ffffff';}
function routePath(){try{return decodeURIComponent(window.location.hash.slice(1))||'';}catch{return '';}}
export function AppShell({config,screens}) {
 const [path,setPath]=useState(routePath),[menuOpen,setMenuOpen]=useState(false),[logoutError,setLogoutError]=useState(''),[logoutPending,setLogoutPending]=useState(false);
 const menuButton=useRef(null),nav=useRef(null),main=useRef(null),restoreFocus=useRef(null);
 const closeMenu=(target="menu")=>{restoreFocus.current=target;setMenuOpen(false);};
 useEffect(()=>{if(!menuOpen&&restoreFocus.current){(restoreFocus.current==="menu"?menuButton:main).current?.focus();restoreFocus.current=null;}},[menuOpen]);
 const session=useOptionalSession(config.authentication);
 const routes=config.routes||[],current=routes.find(r=>r.path===path),home=routes[0]?.path||'/start';
 const navigate=to=>{window.location.hash=to;closeMenu('main');};
 useEffect(()=>{const change=()=>{setPath(routePath());setMenuOpen(false);main.current?.focus();};window.addEventListener('hashchange',change);if(!window.location.hash){history.replaceState(null,'','#'+home);setPath(home);}return ()=>window.removeEventListener('hashchange',change);},[home]);
 useEffect(()=>{
  if(!menuOpen)return;
  nav.current?.querySelector('a,button')?.focus();
  const previous=document.body.style.overflow;document.body.style.overflow='hidden';
  function keys(event){if(event.key==='Escape'){closeMenu();}if(event.key==='Tab'){const elements=[...nav.current.querySelectorAll('a,button')];const first=elements[0],last=elements.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}
  const query=window.matchMedia('(min-width: 960px)'),resize=()=>{if(query.matches)setMenuOpen(false);};
  document.addEventListener('keydown',keys);query.addEventListener('change',resize);
  return ()=>{document.body.style.overflow=previous;document.removeEventListener('keydown',keys);query.removeEventListener('change',resize);};
 },[menuOpen]);
 const Current=current&&screens['./screens/'+current.screen+'.jsx']?.default;
 const primary=/^#[0-9a-fA-F]{6}$/.test(config.theme?.primary)?config.theme.primary:'#17324d';
 const accent=/^#[0-9a-fA-F]{6}$/.test(config.theme?.accent)?config.theme.accent:'#3767e8';
 const signedIn=!session.required||Boolean(session.user),displayName=session.user?.user_metadata?.full_name||session.user?.email;
 async function logout(){if(logoutPending)return;setLogoutPending(true);setLogoutError('');try{await session.signOut();navigate(home);}catch{setLogoutError("Could not sign out. Try again.");}finally{setLogoutPending(false);}}
 return <PortalContext.Provider value={{config,navigate,currentRoute:current,user:session.user}}><div className="bim-shell" style={{'--bim-primary':primary,'--bim-accent':accent,'--bim-accent-ink':contrastInk(accent),'--bim-primary-ink':contrastInk(primary)}}><a className="bim-skip" href="#app-content" onClick={event=>{event.preventDefault();main.current?.focus();}}>Skip to content</a>
  <header className="bim-header" inert={menuOpen||undefined}><div className="bim-brand">{config.logoUrl&&/^https:\/\//.test(config.logoUrl)?<img src={config.logoUrl} alt="" referrerPolicy="no-referrer"/>:<span className="bim-logo" aria-hidden="true">{config.logoText||config.appName?.slice(0,2)}</span>}<div><strong>{config.appName}</strong>{config.tagline&&<small>{config.tagline}</small>}</div></div><div className="bim-header-actions">{signedIn&&displayName&&<span className="bim-account">{displayName}</span>}{session.required&&session.user&&<Button variant="secondary" onClick={logout} pending={logoutPending}><Icon name="logout"/>Sign out</Button>}{signedIn&&<button ref={menuButton} className="bim-menu-toggle" onClick={()=>setMenuOpen(!menuOpen)} aria-label="Open menu" aria-controls="app-navigation" aria-expanded={menuOpen}><Icon name="menu"/></button>}</div></header>
  <div className="bim-workspace">{signedIn&&<>{menuOpen&&<div className="bim-backdrop" onClick={()=>{closeMenu();}}/>}<div ref={nav} id="app-navigation" className={'bim-navigation '+(menuOpen?'is-open':'')} role={menuOpen?'dialog':undefined} aria-modal={menuOpen?true:undefined} aria-label={menuOpen?"Navigation menu":undefined}><div className="bim-mobile-nav-heading"><strong>Menu</strong><button onClick={()=>{closeMenu();}} aria-label="Close menu"><Icon name="close"/></button></div><nav aria-label="Main navigation">{routes.map(route=><a key={route.path} href={'#'+route.path} aria-current={current?.path===route.path?'page':undefined} onClick={()=>closeMenu('main')}><Icon name={route.icon}/><span>{route.title}</span></a>)}</nav></div></>}
  <main ref={main} tabIndex={-1} id="app-content" className="bim-main" inert={menuOpen||undefined}>{logoutError&&<div className="bim-logout-error" role="alert">{logoutError}</div>}{!signedIn?<LoginScreen session={session} appName={config.appName}/>:<ScreenBoundary key={path} onHome={()=>navigate(home)}>{Current?<Current/>:<Page title="Screen not found" description="This page does not exist or has moved."><Button onClick={()=>navigate(home)}>Back to home</Button></Page>}</ScreenBoundary>}</main></div>
  {config.footer?.visible!==false&&<footer className="bim-footer">{config.footer?.text||config.appName}</footer>}
 </div></PortalContext.Provider>;
}
