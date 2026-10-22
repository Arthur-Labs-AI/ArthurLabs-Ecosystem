import Link from 'next/link';
export const metadata = { title: 'Hardware Research' };
export default function HardwarePage() {
  return <section className="foundation section hardware-foundation"><div className="shell"><div className="eyebrow">HARDWARE RESEARCH</div><h1>Beyond the screen.</h1><p className="lede">Exploring wearable input, dedicated computing, and new ways to connect people with intelligent tools.</p><p className="foundation-note">Concept and prototyping — not a released product. Further details will follow in a dedicated website phase.</p><Link className="text-link" href="/#hardware">Back to the overview ↗</Link></div></section>;
}
