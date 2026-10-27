import {Page,Notice} from '../studio/ui/components.jsx';
import {usePortal} from '../studio/ui/AppShell.jsx';
export default function HomeScreen(){
 const {config}=usePortal();
 return <Page title="Welcome" description={"This is the home screen of "+config.appName+'.'}><div className="bim-card"><h2>Room for your idea</h2><p>Describe a screen or feature you want to add in Open Vibe Coder. Your app takes shape one step at a time.</p></div><Notice>Your app works without sign-in or data connections. You can configure Supabase and an external API later.</Notice></Page>;
}
