import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Pancake Auction',
  description: 'NBA dynasty startup auction room'
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
