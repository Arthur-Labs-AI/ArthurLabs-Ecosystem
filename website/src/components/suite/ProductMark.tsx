import type { ProductId } from '@/lib/products';
import styles from './suite.module.css';
export function ProductMark({ product }: { product: ProductId }) {
  return <span className={styles.mark} data-product={product} aria-hidden="true">{product === 'studio' ? 'A' : product === 'nexus' ? 'N' : 'S'}</span>;
}
