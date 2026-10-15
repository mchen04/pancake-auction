import { createRoot } from 'react-dom/client';
import Room from '../app/page';
import { AuctionProvider } from '../app/provider';
async function main() {
    const config = await (await fetch('/client-config.json' + location.search)).json();
    localStorage.setItem('pancake-seat', config.token);
    createRoot(document.getElementById('root')!).render(<AuctionProvider url={config.url}><Room /></AuctionProvider>);
}
void main();
