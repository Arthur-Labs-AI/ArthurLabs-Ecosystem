import Image from 'next/image';
import Link from 'next/link';
import { products } from '@/lib/products';
import { ProductMark } from './ProductMark';
import styles from './suite.module.css';
export function IndependentProducts() {
  return <section id="suite-products" className={styles.independent} aria-labelledby="independent-title"><div className={styles.sectionIntro}><div><span className={styles.eyebrow}>03 / INDEPENDENT BY DESIGN</span><h2 id="independent-title">A shared direction.<br/><em>A distinct purpose.</em></h2></div><p>Use a workspace for what it does best. Explore the connections when they add value. The suite is a family of tools, each with its own identity.</p></div><div className={styles.productGrid}>{products.map(product => <article key={product.id} className={styles.productCard} data-suite-entry data-product={product.id}><div className={styles.productCardTop}><ProductMark product={product.id}/><span>{product.role}</span></div><h3>{product.name}</h3><p>{product.summary}</p><div className={styles.miniCapture}><Image src={`/images/${product.id}.webp`} alt={product.alt} width={product.width} height={product.height} sizes="(max-width: 760px) 88vw, 33vw" quality={90}/></div><Link href={`/${product.id}`}>Explore {product.name}<span aria-hidden="true">↗</span></Link></article>)}</div></section>;
}
