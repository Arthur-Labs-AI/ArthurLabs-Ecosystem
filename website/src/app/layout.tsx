import type { Metadata } from 'next';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'ArthurLabs — From idea to impact.', template: '%s — ArthurLabs' },
  description: 'ArthurLabs: connected tools for ideas, orchestration and independent verification.',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><div className="noise" aria-hidden="true"/><Navbar/><main id="main" tabIndex={-1}>{children}</main><Footer/></body></html>;
}
