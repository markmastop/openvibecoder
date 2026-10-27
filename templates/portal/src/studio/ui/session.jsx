import {useState,useEffect,useCallback} from 'react';
import {getSupabase,isSupabaseConfigured} from '../supabase.js';
import {Page,Field,Button,Notice,LoadingState} from './components.jsx';
export function useOptionalSession(mode) {
 const [state,setState]=useState({loading:mode==='supabase',user:null,error:''});
 useEffect(()=>{
  if(mode!=='supabase'){setState({loading:false,user:null,error:''});return;}
  if(!isSupabaseConfigured()){setState({loading:false,user:null,error:"Supabase is not configured yet."});return;}
  let active=true;const client=getSupabase();
  client.auth.getSession().then(({data,error})=>{if(active)setState({loading:false,user:data?.session?.user||null,error:error?"The session could not be loaded.":''});}).catch(()=>{if(active)setState({loading:false,user:null,error:"There is a connection problem."});});
  const {data}=client.auth.onAuthStateChange((_event,session)=>{if(active)setState({loading:false,user:session?.user||null,error:''});});
  return ()=>{active=false;data.subscription.unsubscribe();};
 },[mode]);
 const signOut=useCallback(async()=>{const {error}=await getSupabase().auth.signOut();if(error)throw error;},[]);
 return {...state,required:mode==='supabase',configured:isSupabaseConfigured(),signOut};
}
export function LoginScreen({session,appName}) {
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 async function submit(event){event.preventDefault();if(pending)return;setPending(true);setError('');const data=new FormData(event.currentTarget);try{const result=await getSupabase().auth.signInWithPassword({email:String(data.get('email')),password:String(data.get('password'))});if(result.error)throw result.error;}catch{setError("Could not sign in. Check your credentials and connection, then try again.");}finally{setPending(false);}}
 if(session.loading)return <LoadingState label="Loading session…"/>;
 return <Page title={"Sign in to "+appName} description="Use your own account.">{!session.configured?<Notice tone="error">{session.error} Configure the connection in Open Vibe Coder and rebuild.</Notice>:<form onSubmit={submit} className="bim-login"><Field label="Email address" name="email" type="email" autoComplete="username" required/><Field label="Password" name="password" type="password" autoComplete="current-password" required/>{(error||session.error)&&<Notice tone="error">{error||session.error}</Notice>}<Button type="submit" pending={pending}>Sign in</Button></form>}</Page>;
}
