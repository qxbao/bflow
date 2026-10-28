import { BrowserRouter } from 'react-router';
import { App } from './app';
import type { ApiClient } from './api/client';
export function Router({api,bootstrap}:{api:ApiClient;bootstrap?:string|undefined}) { return <BrowserRouter><App api={api} bootstrap={bootstrap}/></BrowserRouter>; }
