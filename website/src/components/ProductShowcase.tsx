import Image from 'next/image';
import Link from 'next/link';
import type { Product } from '@/lib/products';
export function ProductShowcase({ product }: { product: Product }) {
  return <section className={`product ${product.windowClass}-product`} id={product.id}><div className="info"><div className={`role ${product.color}`}>{product.name.toUpperCase()} / {product.role}</div><h2>{product.title[0]}<br/>{product.title[1]}</h2><p>{product.description}</p><Link className="text-link" href={`/${product.id}`}>Explore {product.name} <span aria-hidden="true">↗</span></Link></div><div className="visual"><Image src={`/images/${product.id}.webp`} alt={product.alt} width={product.width} height={product.height} quality={90} sizes="(max-width: 900px) 88vw, (max-width: 1440px) 46vw, 640px"/></div></section>;
}
