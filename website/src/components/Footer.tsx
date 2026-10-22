import Link from 'next/link';
import { Brand } from './Brand';
export function Footer() {
  return <footer id="footer"><div className="footer-top"><div><Brand/><div className="statement">The next idea<br/>starts here.</div><p className="footer-note">Connected tools for ideas, orchestration, and independent verification. Explore the approach behind ArthurLabs.</p></div><div className="footer-cols"><div><span>Explore</span><Link href="/suite">Full Suite</Link><Link href="/studio">Arthur Studio</Link><Link href="/nexus">Nexus</Link><Link href="/sentry">Sentry</Link></div><div><span>ArthurLabs</span><Link href="/hardware">Hardware</Link><Link href="/#philosophy">Our approach</Link><a href="#main">Back to top ↑</a></div></div></div><div className="footer-bottom"><span>ArthurLabs © 2026</span><span>Thought / Execution / Verification</span></div></footer>;
}
