import Link from 'next/link';
import { products } from '@/lib/products';
export function SuiteSection() {
  return <section className="section suite" id="suite"><div className="shell"><div className="section-tag">01 / A CONNECTED SYSTEM</div><h2>Built independently.<br/>Connected intentionally.</h2><p className="lede">ArthurLabs is a family of focused tools. Each product solves a different part of the journey — from capturing ideas to orchestrating execution and validating results.</p><div className="suite-grid">{products.map((product, index) => <article key={product.id} className={`suite-card ${product.windowClass}`}><div className="index">0{index + 1} / {['IDEAS', 'EXECUTION', 'VERIFICATION'][index]}</div><h3><Link href={`/${product.id}`}>{product.name}</Link></h3><p>{product.summary}</p></article>)}</div></div></section>;
}
