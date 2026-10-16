import type { Metadata, Viewport } from 'next';
import { Barlow_Condensed, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';
import { connection } from 'next/server';
import { AuctionProvider } from './provider';

const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display' });
const body = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'Pancake Auction',
  description: 'Live startup auction room for the Pancake dynasty league'
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#e8ecf1' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const url = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  return <html lang="en" className={`${display.variable} ${body.variable}`}><body><AuctionProvider url={url}>{children}</AuctionProvider></body></html>;
}
