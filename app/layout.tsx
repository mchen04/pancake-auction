import type { Metadata, Viewport } from 'next';
import { Barlow_Condensed, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';
import { connection } from 'next/server';
import { AuctionProvider } from './provider';
import { AppUpdater } from './updater';

const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display' });
const body = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'Pancake Auction',
  description: "Pancake dynasty league auction room",
  appleWebApp: { capable: true, title: 'Pancake Auction', statusBarStyle: 'default' },
  icons: {
    icon: [{ url: '/favicon.ico', sizes: '16x16 32x32 48x48' }, { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
  },
  other: { 'apple-mobile-web-app-capable': 'yes' }
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#e8ecf1' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const url = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  return <html lang="en" className={`${display.variable} ${body.variable}`} data-version={process.env.APP_VERSION}>
    <body><AppUpdater /><AuctionProvider url={url}>{children}</AuctionProvider></body></html>;
}
