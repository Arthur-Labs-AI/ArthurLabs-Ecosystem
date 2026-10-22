import Link from 'next/link';
import { products } from '@/lib/products';
import { ProductMark } from './ProductMark';
import styles from './suite.module.css';
export function SuiteAvailability() {
  return <section className={styles.availability} aria-labelledby="availability-title"><div className={styles.availabilityHeading}><span className={styles.eyebrow}>05 / GET THE SUITE</span><h2 id="availability-title">Find your<br/><em>starting point.</em></h2><p>Get to know each workspace. Verified release, platform, and download information will be added when available.</p></div><div className={styles.availabilityList} data-suite-entry>{products.map(product => <div key={product.id}><ProductMark product={product.id}/><div><h3>{product.name}</h3><p>Release & platform details unconfirmed here.</p></div><Link href={`/${product.id}`} aria-label={`View ${product.name} product information`}>Product details <span aria-hidden="true">↗</span></Link></div>)}<p>There are no downloads offered in this prototype.</p></div></section>;
}
