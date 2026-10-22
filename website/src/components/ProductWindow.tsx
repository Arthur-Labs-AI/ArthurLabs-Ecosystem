import Image from 'next/image';
import type { Product } from '@/lib/products';
export function ProductWindow({ product, ready, selected, onSelect }: { product: Product; ready: boolean; selected: boolean; onSelect: () => void }) {
  return <button type="button" disabled={!ready} className={`window ${product.windowClass}`} aria-label={`Focus ${product.name} preview`} aria-pressed={selected} onClick={onSelect}>
    <span className="window-top" aria-hidden="true"><i className="dot"/><i className="dot"/><i className="dot"/><span className="top-label">{product.name.toUpperCase()}</span></span>
    <span className="image-wrap"><Image src={`/images/${product.id}.webp`} alt={product.alt} fill quality={90} sizes="(max-width: 760px) 100vw, (max-width: 1100px) 60vw, 760px" priority/></span>
  </button>;
}
