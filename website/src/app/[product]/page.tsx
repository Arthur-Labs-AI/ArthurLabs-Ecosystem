import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { products } from '@/lib/products';
export const dynamicParams = false;
export function generateStaticParams() { return products.map(product => ({ product: product.id })); }
export async function generateMetadata({ params }: { params: Promise<{ product: string }> }) {
  const { product: id } = await params;
  return { title: products.find(product => product.id === id)?.name ?? 'Product' };
}
export default async function ProductPage({ params }: { params: Promise<{ product: string }> }) {
  const { product: id } = await params;
  const product = products.find(product => product.id === id);
  if (!product) notFound();
  return <section className="foundation section"><div className="shell"><div className={`role ${product.color}`}>{product.role}</div><h1>{product.name}</h1><p className="lede">{product.description}</p><p className="foundation-note">A closer look at {product.name} is coming in a future website phase.</p><Link className="text-link" href={`/#${product.id}`}>Back to the overview ↗</Link><div className="foundation-image"><Image src={`/images/${product.id}.webp`} alt={product.alt} width={product.width} height={product.height} sizes="90vw" priority/></div></div></section>;
}
