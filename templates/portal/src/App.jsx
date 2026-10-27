// BIM-APP-SHELL v1: Open Vibe Coder manages this entry; add screens under src/screens/.
import {AppShell} from './studio/ui/AppShell.jsx';
import config from './app-config.json';
const screens = import.meta.glob('./screens/*.jsx', {eager:true});
export default function App(){return <AppShell config={config} screens={screens}/>;}
